// ============================================================
// CONFIGURATION
// ============================================================
const API_URL = "/api/sheets-proxy";
const TREASURER_NAME = "Mrs. Kithinji";
const VAPID_PUBLIC_KEY = 'BB4N47xyKjLw-K29lXDolpcht45pVZcqV4m-Iw-8tJBk8g21yE66KVJmxbNOIDEIRBun-JDACI0lK4MRIvVwYH0';

let allRecords = [], allMembers = [], allMembersData = [], pendingLoans = [], completedLoans = [];
let pendingTransactions = [], pendingEditsMap = {}, activeLoans = [], loansAwaitingDueDate = [];
let currentUser = null, currentUserEmail = null, currentUserRole = null;
let currentTab = localStorage.getItem('legacy_active_tab') || 'transactions';
let countdownInterval = null, refreshInterval = null;
let userProfileImage = localStorage.getItem('legacy_profile_image') || null;
let isLoading = false, chartInstance = null;
const memberPhotoCache = {};
let serviceWorkerRegistered = false, pushSubscription = null;

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function isTreasurer() { return currentUser === TREASURER_NAME; }

function isDeveloper() { return currentUserRole === 'developer'; }

function showToast(message, type) {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

function showButtonLoading(btn, text) {
    btn.disabled = true;
    btn.innerHTML = `<span class="login-loading"></span> ${text}`;
}

function hideButtonLoading(btn, originalText) {
    btn.disabled = false;
    btn.innerHTML = originalText;
}

function getInitials(name) {
    if (!name) return '?';
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ============================================================
// API CALL
// ============================================================
async function callAPI(action, data = {}, _retryCount = 0) {
    const MAX_RETRIES = 2;
    try {
        const params = new URLSearchParams({ action, ...data });
        const url = `${API_URL}?${params.toString()}`;
        const response = await fetch(url);
        if (!response.ok) {
            if (response.status === 502 && _retryCount < MAX_RETRIES) {
                const backoffMs = 800 * Math.pow(2, _retryCount);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                return callAPI(action, data, _retryCount + 1);
            }
            throw new Error(`HTTP ${response.status}`);
        }
        return await response.json();
    } catch (e) {
        console.error('API Error:', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// SPLASH SCREEN
// ============================================================
function hideSplashScreen() {
    const splash = document.getElementById('splashScreen');
    splash.classList.add('hidden');
    setTimeout(() => splash.style.display = 'none', 500);
}

// ============================================================
// LOGIN FUNCTIONS
// ============================================================
let pendingLoginToken = null, pendingLoginEmail = null, otpResendTimer = null;

function checkPersistentLogin() {
    const saved = localStorage.getItem('legacy_current_user');
    const savedEmail = localStorage.getItem('legacy_current_email');
    const savedRole = localStorage.getItem('legacy_current_role');
    if (saved && savedEmail) {
        currentUser = saved;
        currentUserEmail = savedEmail;
        currentUserRole = savedRole || 'member';
        return true;
    }
    return false;
}

function showLoginForm() {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('forgotPasswordForm').style.display = 'none';
    document.getElementById('otpForm').style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('registerError').style.display = 'none';
    document.getElementById('resetError').style.display = 'none';
    document.getElementById('resetSuccess').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = 'Welcome back — login to access your account';
}

function showRegisterForm() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'block';
    document.getElementById('forgotPasswordForm').style.display = 'none';
    document.getElementById('otpForm').style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('registerError').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = 'Join the circle — create your account';
}

function showForgotPasswordForm() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('forgotPasswordForm').style.display = 'block';
    document.getElementById('otpForm').style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('resetError').style.display = 'none';
    document.getElementById('resetSuccess').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = "We'll help you get back in";
}

function showOtpScreen(emailHint) {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('forgotPasswordForm').style.display = 'none';
    document.getElementById('otpForm').style.display = 'block';
    document.getElementById('otpEmailHint').textContent = emailHint || pendingLoginEmail || '';
    document.getElementById('otpError').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = 'Enter the code we emailed you';
    clearOtpBoxes();
    startOtpResendCountdown();
    setTimeout(focusFirstOtpBox, 100);
}

function backToLoginFromOtp() {
    pendingLoginToken = null;
    pendingLoginEmail = null;
    if (otpResendTimer) clearInterval(otpResendTimer);
    clearOtpBoxes();
    document.getElementById('otpForm').style.display = 'none';
    showLoginForm();
}

// ---- OTP Boxes ----
function otpBoxes() { return Array.from(document.querySelectorAll('.otp-box')); }
function getOtpValue() { return otpBoxes().map(b => b.value).join(''); }
function clearOtpBoxes() { otpBoxes().forEach(b => b.value = ''); }
function focusFirstOtpBox() { const b = otpBoxes()[0]; if (b) b.focus(); }

function initOtpBoxes() {
    const boxes = otpBoxes();
    boxes.forEach((box, i) => {
        box.addEventListener('input', () => {
            box.value = box.value.replace(/\D/g, '').slice(0, 1);
            if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
            if (getOtpValue().length === 6) verifyOtpAndLogin();
        });
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Backspace' && !box.value && i > 0) boxes[i - 1].focus();
        });
        box.addEventListener('paste', (e) => {
            e.preventDefault();
            const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 6);
            digits.split('').forEach((d, k) => { if (boxes[k]) boxes[k].value = d; });
            if (digits.length === 6) verifyOtpAndLogin();
            else if (boxes[digits.length]) boxes[digits.length].focus();
        });
    });
}
document.addEventListener('DOMContentLoaded', initOtpBoxes);

function startOtpResendCountdown() {
    const btn = document.getElementById('otpResendBtn');
    if (!btn) return;
    let left = 60;
    btn.disabled = true;
    if (otpResendTimer) clearInterval(otpResendTimer);
    const tick = () => {
        btn.textContent = left > 0 ? `Resend code in ${left}s` : 'Resend code';
        if (left <= 0) { btn.disabled = false; clearInterval(otpResendTimer); }
        left--;
    };
    tick();
    otpResendTimer = setInterval(tick, 1000);
}

async function loginWithPassword() {
    const email = document.getElementById('loginEmail').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errorEl = document.getElementById('loginError');
    errorEl.style.display = 'none';
    if (!email || !password) {
        errorEl.textContent = 'Please enter email and password';
        errorEl.style.display = 'block';
        return;
    }
    const btn = document.getElementById('loginBtn');
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Logging in...');
    try {
        const res = await callAPI('login', { email, password });
        if (res.success && res.status === 'otp_sent') {
            pendingLoginToken = res.token;
            pendingLoginEmail = email;
            if (res.name) localStorage.setItem('legacy_temp_name', res.name);
            if (res.role) localStorage.setItem('legacy_temp_role', res.role);
            showOtpScreen(res.emailHint);
        } else if (res.success) {
            await completeLogin(res.name, email);
        } else {
            errorEl.textContent = res.error || 'Invalid email or password';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Error connecting to server';
        errorEl.style.display = 'block';
    }
    hideButtonLoading(btn, orig);
}

async function verifyOtpAndLogin() {
    const err = document.getElementById('otpError');
    err.style.display = 'none';
    const code = getOtpValue();
    if (code.length !== 6) {
        err.textContent = 'Enter all 6 digits.';
        err.style.display = 'block';
        return;
    }
    const btn = document.getElementById('otpVerifyBtn');
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Verifying...');
    try {
        const res = await callAPI('verifyOtp', { token: pendingLoginToken, code });
        if (res.success) {
            let userName = res.name;
            if (!userName || userName.trim() === '') {
                userName = localStorage.getItem('legacy_temp_name');
                if (!userName) userName = pendingLoginEmail ? pendingLoginEmail.split('@')[0] : 'Member';
                userName = userName.charAt(0).toUpperCase() + userName.slice(1);
            }
            currentUserRole = res.role || localStorage.getItem('legacy_temp_role') || 'member';
            if (otpResendTimer) clearInterval(otpResendTimer);
            document.getElementById('otpForm').style.display = 'none';
            const savedEmail = res.email || pendingLoginEmail;
            pendingLoginToken = null;
            pendingLoginEmail = null;
            localStorage.removeItem('legacy_temp_name');
            localStorage.removeItem('legacy_temp_role');
            await completeLogin(userName, savedEmail);
        } else {
            err.textContent = res.error || 'Verification failed.';
            err.style.display = 'block';
            clearOtpBoxes();
            focusFirstOtpBox();
        }
    } catch (e) {
        err.textContent = 'Error connecting to server';
        err.style.display = 'block';
    }
    hideButtonLoading(btn, orig);
}

async function resendOtpCode() {
    const err = document.getElementById('otpError');
    err.style.display = 'none';
    const res = await callAPI('resendOtp', { token: pendingLoginToken });
    if (res.success) {
        showToast('New code sent', 'success');
        document.getElementById('otpEmailHint').textContent = res.emailHint;
        clearOtpBoxes();
        focusFirstOtpBox();
        startOtpResendCountdown();
    } else {
        err.textContent = res.error || 'Could not resend code.';
        err.style.display = 'block';
    }
}

// ============================================================
// COMPLETE LOGIN
// ============================================================
async function completeLogin(name, email) {
    if (!name || name.trim() === '') {
        name = email ? email.split('@')[0] : 'Member';
        name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    currentUser = name;
    currentUserEmail = email;
    localStorage.setItem('legacy_current_user', currentUser);
    localStorage.setItem('legacy_current_email', email);
    localStorage.setItem('legacy_current_role', currentUserRole || 'member');

    const profileRes = await callAPI('getProfileImage', { email });
    if (profileRes.success && profileRes.image) {
        userProfileImage = profileRes.image;
        localStorage.setItem('legacy_profile_image', userProfileImage);
    }

    document.getElementById('loginOverlay').classList.remove('active');
    document.getElementById('appContainer').classList.add('active');
    document.getElementById('tabBar').style.display = 'flex';
    document.getElementById('sidebarNav').classList.add('active');
    document.getElementById('loggedInUser').innerText = currentUser;
    document.getElementById('date').value = new Date().toISOString().split('T')[0];

    updateHeaderAvatar();
    updateDashboardGreeting();
    showHideDeveloperPortal();
    showHidePendingTab();

    showBalanceLoading(true);
    initMemoriesCarousel();
    await loadAllData();
    await delay(150);
    await Promise.all([
        loadMeetingMinutes(),
        delay(150).then(() => loadScheduledMeeting()),
        delay(300).then(() => loadMembersList())
    ]);

    document.querySelectorAll('.tab, .sidebar-link').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active-panel'));
    const activeTabBtn = document.querySelector(`.tab[data-panel="${currentTab}"]`);
    if (activeTabBtn) activeTabBtn.classList.add('active');
    const activeSidebarBtn = document.querySelector(`.sidebar-link[data-panel="${currentTab}"]`);
    if (activeSidebarBtn) activeSidebarBtn.classList.add('active');
    const activePanel = document.getElementById(currentTab + 'Panel');
    if (activePanel) {
        ensureFullscreenBar(activePanel, currentTab);
        activePanel.classList.add('active-panel', 'panel-enter');
    }
    const appContainerEl = document.getElementById('appContainer');
    if (appContainerEl) appContainerEl.classList.toggle('dashboard-active', currentTab === 'transactions');
    localStorage.setItem('legacy_active_tab', currentTab);
    showBalanceLoading(false);
    showToast(`Welcome ${currentUser}!`, 'success');

    setTimeout(() => {
        checkAndShowNotificationPrompt();
        registerServiceWorker();
    }, 3000);

    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
        if (currentUser) {
            loadAllData(true);
            loadScheduledMeeting();
            loadMembersList();
        }
    }, 30000);
}

function showHideDeveloperPortal() {
    const isDev = isDeveloper();
    document.getElementById('developerTab').style.display = isDev ? 'flex' : 'none';
    document.getElementById('developerSidebarLink').style.display = isDev ? 'flex' : 'none';
    document.getElementById('developerPanel').style.display = isDev ? 'block' : 'none';
    if (isDev) loadDeveloperPortal();
}

function showHidePendingTab() {
    const show = isTreasurer() || isDeveloper();
    document.getElementById('pendingTab').style.display = show ? 'flex' : 'none';
    document.getElementById('pendingSidebarLink').style.display = show ? 'flex' : 'none';
    if (show) loadPendingRegistrations();
}

// ============================================================
// REGISTRATION
// ============================================================
async function registerUser() {
    const email = document.getElementById('registerEmail').value.trim();
    const name = document.getElementById('registerName').value.trim();
    const password = document.getElementById('registerPassword').value;
    const confirmPassword = document.getElementById('registerConfirmPassword').value;
    const errorEl = document.getElementById('registerError');
    errorEl.style.display = 'none';
    if (!email || !name || !password || !confirmPassword) {
        errorEl.textContent = 'Please fill all fields';
        errorEl.style.display = 'block';
        return;
    }
    if (!email.includes('@')) {
        errorEl.textContent = 'Please enter a valid email address';
        errorEl.style.display = 'block';
        return;
    }
    if (password.length < 6) {
        errorEl.textContent = 'Password must be at least 6 characters';
        errorEl.style.display = 'block';
        return;
    }
    if (password !== confirmPassword) {
        errorEl.textContent = 'Passwords do not match';
        errorEl.style.display = 'block';
        return;
    }
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Creating account...');
    try {
        const res = await callAPI('register', { email, name, password });
        if (res.success) {
            if (res.status === 'pending') {
                showToast('Registration submitted! Waiting for approval.', 'success');
            } else {
                showToast('Account created successfully! Please login.', 'success');
            }
            showLoginForm();
            document.getElementById('loginEmail').value = email;
            document.getElementById('registerEmail').value = '';
            document.getElementById('registerName').value = '';
            document.getElementById('registerPassword').value = '';
            document.getElementById('registerConfirmPassword').value = '';
        } else {
            errorEl.textContent = res.error || 'Registration failed';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Error connecting to server';
        errorEl.style.display = 'block';
    }
    hideButtonLoading(btn, orig);
}

// ============================================================
// PASSWORD RESET
// ============================================================
async function requestPasswordReset() {
    const email = document.getElementById('resetEmail').value.trim();
    const errorEl = document.getElementById('resetError');
    const successEl = document.getElementById('resetSuccess');
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    if (!email) {
        errorEl.textContent = 'Please enter your email';
        errorEl.style.display = 'block';
        return;
    }
    if (!email.includes('@')) {
        errorEl.textContent = 'Please enter a valid email';
        errorEl.style.display = 'block';
        return;
    }
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Sending...');
    try {
        const res = await callAPI('resetPassword', { email });
        if (res.success) {
            successEl.textContent = '✅ Password reset successfully! Check your email.';
            successEl.style.display = 'block';
            showToast('Password reset sent to your email', 'success');
            setTimeout(() => showLoginForm(), 3000);
        } else {
            errorEl.textContent = res.error || 'Failed to reset password';
            errorEl.style.display = 'block';
        }
    } catch (e) {
        errorEl.textContent = 'Error connecting to server';
        errorEl.style.display = 'block';
    }
    hideButtonLoading(btn, orig);
}

// ============================================================
// PROFILE IMAGE FUNCTIONS
// ============================================================
function updateHeaderAvatar() {
    const avatarEl = document.getElementById('headerAvatar');
    if (!avatarEl) return;
    if (userProfileImage) {
        avatarEl.innerHTML = `<img src="${userProfileImage}" alt="${currentUser}">`;
        avatarEl.style.background = 'transparent';
    } else {
        avatarEl.innerHTML = getInitials(currentUser);
        avatarEl.style.background = 'rgba(255,255,255,0.3)';
        avatarEl.style.color = 'white';
        avatarEl.style.fontSize = '12px';
        avatarEl.style.fontWeight = '600';
    }
}

function updateDashboardGreeting() {
    const el = document.getElementById('dashboardGreeting');
    if (!el || !currentUser) return;
    const hour = new Date().getHours();
    const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    el.textContent = `👋 ${timeGreeting}, ${currentUser.split(' ')[0]}`;
}

// ============================================================
// DEVELOPER PORTAL FUNCTIONS
// ============================================================
async function loadDeveloperPortal() {
    if (!isDeveloper()) return;
    await loadSystemStats();
    await loadAllUsersFull();
    await loadDevPendingRegistrations();
    await loadDevAuditLog();
}

async function loadSystemStats() {
    const container = document.getElementById('systemStats');
    try {
        const res = await callAPI('getSystemStats', { email: currentUserEmail });
        if (res.success && res.stats) {
            const s = res.stats;
            container.innerHTML = `
                <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px;">
                    <div class="summary-stat" style="background: #E8EEFF;"><div class="summary-stat-value">${s.totalUsers}</div><div class="summary-stat-label">Total Users</div></div>
                    <div class="summary-stat" style="background: #FFF8E1;"><div class="summary-stat-value">${s.pendingRegistrations}</div><div class="summary-stat-label">Pending Registrations</div></div>
                    <div class="summary-stat" style="background: #E1F7EC;"><div class="summary-stat-value">${s.pendingTransactions}</div><div class="summary-stat-label">Pending Transactions</div></div>
                    <div class="summary-stat" style="background: #FBE2E2;"><div class="summary-stat-value">${s.pendingLoans}</div><div class="summary-stat-label">Pending Loans</div></div>
                    <div class="summary-stat" style="background: #E8EEFF;"><div class="summary-stat-value">${s.activeLoans}</div><div class="summary-stat-label">Active Loans</div></div>
                    <div class="summary-stat" style="background: #E1F7EC;"><div class="summary-stat-value">KES ${(s.totalSavings || 0).toLocaleString()}</div><div class="summary-stat-label">Total Savings</div></div>
                    <div class="summary-stat" style="background: #FBE2E2;"><div class="summary-stat-value">KES ${(s.outstandingLoans || 0).toLocaleString()}</div><div class="summary-stat-label">Outstanding Loans</div></div>
                    <div class="summary-stat" style="background: #E8EEFF;"><div class="summary-stat-value">${s.pushSubscriptions}</div><div class="summary-stat-label">Push Subscriptions</div></div>
                </div>
            `;
        }
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading stats</div>';
    }
}

async function loadAllUsersFull() {
    const container = document.getElementById('allUsersList');
    try {
        const res = await callAPI('getAllUsersFull', { email: currentUserEmail });
        if (res.success && res.users) {
            container.innerHTML = `
                <div style="overflow-x: auto;">
                    <table class="history-table">
                        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
                        <tbody>
                            ${res.users.map(user => `
                                <tr>
                                    <td><strong>${escapeHtml(user.name)}</strong></td>
                                    <td>${escapeHtml(user.email)}</td>
                                    <td><span class="badge ${user.role === 'developer' ? 'badge-savings' : user.role === 'admin' ? 'badge-loan' : 'badge-repayment'}">${user.role || 'member'}</span></td>
                                    <td><span class="badge ${user.status === 'approved' ? 'badge-savings' : user.status === 'pending' ? 'badge-repayment' : 'badge-loan'}">${user.status || 'pending'}</span></td>
                                    <td>${user.email !== currentUserEmail ? `
                                        <select onchange="updateUserRole('${user.email}', this.value)" style="width: auto; padding: 4px 8px; font-size: 11px;">
                                            <option value="member" ${user.role === 'member' ? 'selected' : ''}>Member</option>
                                            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Treasurer</option>
                                            <option value="developer" ${user.role === 'developer' ? 'selected' : ''}>Developer</option>
                                        </select>
                                        <button onclick="deleteUser('${user.email}')" style="background: #E5484D; color: white; width: auto; padding: 4px 10px; font-size: 11px; margin-top: 4px;">🗑️</button>
                                    ` : '<em>You</em>'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            `;
        }
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading users</div>';
    }
}

async function loadDevPendingRegistrations() {
    const container = document.getElementById('devPendingRegistrations');
    try {
        const res = await callAPI('getPendingRegistrations', { email: currentUserEmail });
        if (res.success && res.registrations) {
            if (res.registrations.length === 0) {
                container.innerHTML = '<div class="empty-state">No pending registrations</div>';
                return;
            }
            container.innerHTML = res.registrations.map(reg => `
                <div class="pending-item" style="background: #FFF8E1; border-left: 4px solid #FF9800;">
                    <div><strong>👤 ${escapeHtml(reg.name)}</strong></div>
                    <div>📧 ${escapeHtml(reg.email)}</div>
                    <div>📅 ${new Date(reg.created_at).toLocaleDateString()}</div>
                    <div style="margin-top: 10px; display: flex; gap: 8px;">
                        <button class="approve-btn" onclick="approveRegistration('${reg.email}')">✅ Approve</button>
                        <button class="reject-btn" onclick="rejectRegistration('${reg.email}')">❌ Reject</button>
                    </div>
                </div>
            `).join('');
        }
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading registrations</div>';
    }
}

async function loadDevAuditLog() {
    const container = document.getElementById('devAuditLog');
    try {
        const res = await callAPI('getDeveloperAuditLog', { email: currentUserEmail, limit: 50 });
        if (res.success && res.entries) {
            container.innerHTML = res.entries.map(entry => `
                <div class="audit-log-row">
                    <div class="audit-log-icon">${auditIconFor(entry.action)}</div>
                    <div class="audit-log-info">
                        <div class="audit-log-line"><strong>${escapeHtml(entry.actor)}</strong> ${escapeHtml(entry.action)}</div>
                        ${entry.details ? `<div class="audit-log-details">${escapeHtml(entry.details)}</div>` : ''}
                        <div class="audit-log-time">${new Date(entry.timestamp).toLocaleString()}</div>
                    </div>
                </div>
            `).join('');
        }
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading audit log</div>';
    }
}

async function updateUserRole(email, role) {
    if (!confirm(`Change role for ${email} to ${role}?`)) return;
    try {
        const res = await callAPI('updateUserRole', { email, role, requesterEmail: currentUserEmail });
        if (res.success) {
            showToast(`✅ Role updated for ${email}`, 'success');
            await loadAllUsersFull();
            await loadSystemStats();
        } else {
            showToast(res.error || 'Error updating role', 'error');
        }
    } catch (e) {
        showToast('Error updating role', 'error');
    }
}

async function deleteUser(email) {
    if (!confirm(`⚠️ Delete user ${email}? This action cannot be undone!`)) return;
    if (!confirm(`Are you absolutely sure?`)) return;
    try {
        const res = await callAPI('deleteUser', { email, requesterEmail: currentUserEmail });
        if (res.success) {
            showToast(`✅ ${email} deleted successfully`, 'success');
            await loadAllUsersFull();
            await loadSystemStats();
        } else {
            showToast(res.error || 'Error deleting user', 'error');
        }
    } catch (e) {
        showToast('Error deleting user', 'error');
    }
}

async function approveRegistration(email) {
    if (!confirm(`Approve ${email}?`)) return;
    try {
        const res = await callAPI('approveRegistration', { email, approvedBy: currentUser });
        if (res.success) {
            showToast(`✅ ${email} approved!`, 'success');
            await loadDevPendingRegistrations();
            await loadPendingRegistrations();
            await loadAllUsersFull();
        } else {
            showToast(res.error || 'Error approving', 'error');
        }
    } catch (e) {
        showToast('Error approving registration', 'error');
    }
}

async function rejectRegistration(email) {
    if (!confirm(`Reject ${email}?`)) return;
    try {
        const res = await callAPI('rejectRegistration', { email, rejectedBy: currentUser });
        if (res.success) {
            showToast(`❌ ${email} rejected`, 'success');
            await loadDevPendingRegistrations();
            await loadPendingRegistrations();
            await loadAllUsersFull();
        } else {
            showToast(res.error || 'Error rejecting', 'error');
        }
    } catch (e) {
        showToast('Error rejecting registration', 'error');
    }
}

async function refreshAllData() {
    showToast('🔄 Refreshing all data...', 'success');
    try {
        const res = await callAPI('refreshAllData', { email: currentUserEmail });
        if (res.success) {
            showToast('✅ All data refreshed!', 'success');
            await loadSystemStats();
            await loadAllUsersFull();
            await loadDevPendingRegistrations();
            await loadDevAuditLog();
            await loadAllData();
        }
    } catch (e) {
        showToast('Error refreshing data', 'error');
    }
}

function exportSystemData() {
    showToast('📥 Export feature coming soon', 'info');
}

function clearSystemCache() {
    if (!confirm('Clear all system caches?')) return;
    localStorage.clear();
    showToast('🗑️ Cache cleared! Refreshing...', 'success');
    setTimeout(() => location.reload(), 2000);
}

function auditIconFor(action) {
    const a = (action || '').toLowerCase();
    if (a.includes('logged in')) return '🔑';
    if (a.includes('joined')) return '👋';
    if (a.includes('password')) return '🔒';
    if (a.includes('photo')) return '🖼️';
    if (a.includes('approved')) return '✅';
    if (a.includes('rejected')) return '❌';
    if (a.includes('requested') || a.includes('submitted')) return '📤';
    if (a.includes('due date')) return '📅';
    return '📋';
}

// ============================================================
// LOAD PENDING REGISTRATIONS (for Treasurer/Developer)
// ============================================================
async function loadPendingRegistrations() {
    const container = document.getElementById('pendingRegistrationsList');
    if (!container) return;
    try {
        const res = await callAPI('getPendingRegistrations', { email: currentUserEmail });
        if (res.success && res.registrations) {
            if (res.registrations.length === 0) {
                container.innerHTML = '<div class="empty-state">No pending registrations</div>';
                return;
            }
            container.innerHTML = res.registrations.map(reg => `
                <div class="pending-item" style="background: #FFF8E1; border-left: 4px solid #FF9800;">
                    <div><strong>👤 ${escapeHtml(reg.name)}</strong></div>
                    <div>📧 ${escapeHtml(reg.email)}</div>
                    <div>📅 ${new Date(reg.created_at).toLocaleDateString()}</div>
                    <div style="margin-top: 10px; display: flex; gap: 8px;">
                        <button class="approve-btn" onclick="approveRegistration('${reg.email}')">✅ Approve</button>
                        <button class="reject-btn" onclick="rejectRegistration('${reg.email}')">❌ Reject</button>
                    </div>
                </div>
            `).join('');
        }
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading registrations</div>';
    }
}

// ============================================================
// LOAD ALL DATA (Dashboard)
// ============================================================
function showBalanceLoading(show) {
    const savings = document.getElementById('totalSavingsTop');
    const loans = document.getElementById('outstandingTop');
    if (savings) savings.classList.toggle('is-loading', show);
    if (loans) loans.classList.toggle('is-loading', show);
}

let walletScope = 'group';
let lastGroupSummary = null;

async function loadAllData(silent = false, skipBalanceUI = false) {
    if (isLoading || !currentUser) return;
    isLoading = true;
    if (!silent && !skipBalanceUI) showBalanceLoading(true);
    try {
        const dash = await callAPI('getDashboardData', {
            includePending: (isTreasurer() || isDeveloper()) ? 'true' : 'false',
            isTreasurer: (isTreasurer() || isDeveloper()) ? 'true' : 'false',
            includeLoanTracking: silent ? 'false' : 'true'
        });
        if (!dash.success) throw new Error(dash.error || 'Failed to load dashboard data');

        allRecords = dash.records || [];
        renderRecentActivity();
        updateAboutStats();

        if (dash.members?.length) {
            allMembers = dash.members;
            updateMemberDropdowns();
        }

        if (dash.summary?.success) {
            if (skipBalanceUI) {
                lastGroupSummary = dash.summary;
            } else {
                if (!silent) showBalanceLoading(false);
                updateBalanceDisplays(dash.summary);
                document.getElementById('summarySkeleton').style.display = 'none';
                document.getElementById('summaryContent').style.display = 'block';
                renderChart(dash.summary);
            }
        }
        if (!skipBalanceUI) renderWalletBalance();

        const total = allMembers.length || 1;
        const allLoans = dash.loans || [];
        pendingLoans = allLoans.filter(l => l.approvals.length < (total - 1) && l.status !== 'completed' && l.status !== 'rejected');
        completedLoans = allLoans.filter(l => l.approvals.length >= (total - 1) || l.status === 'completed');
        renderPendingLoans();
        renderCompletedLoans();

        if (dash.activeLoans !== undefined) {
            activeLoans = dash.activeLoans || [];
            if (!skipBalanceUI) renderActiveLoans();
        }
        if ((isTreasurer() || isDeveloper()) && dash.loansAwaitingDueDate !== undefined) {
            loansAwaitingDueDate = dash.loansAwaitingDueDate || [];
            if (!skipBalanceUI) renderLoansAwaitingDueDate();
        }

        if (isTreasurer() || isDeveloper()) {
            pendingTransactions = dash.pendingTransactions || [];
            pendingEditsMap = dash.pendingEditsMap || {};
            renderPendingApprovals();
            updatePendingCount();
        }
    } catch (e) {
        if (!silent) showToast('Error loading data', 'error');
        console.error(e);
    } finally {
        isLoading = false;
        showBalanceLoading(false);
    }
}

// ============================================================
// UPDATE BALANCE DISPLAYS
// ============================================================
function updateBalanceDisplays(summary) {
    if (!summary) return;
    lastGroupSummary = summary;
    renderWalletBalance();
}

function renderWalletBalance() {
    const labelEl = document.getElementById('walletFooterLabel');
    if (walletScope === 'mine') {
        const stats = getUserStats(currentUser);
        animateCountUp(document.getElementById('totalSavingsTop'), stats.savings || 0);
        animateCountUp(document.getElementById('outstandingTop'), stats.loans || 0);
        if (labelEl) labelEl.textContent = 'Your Loans';
    } else {
        const savings = lastGroupSummary?.savings || 0;
        const outstanding = lastGroupSummary?.outstanding || 0;
        animateCountUp(document.getElementById('totalSavingsTop'), savings);
        animateCountUp(document.getElementById('outstandingTop'), outstanding);
        if (labelEl) labelEl.textContent = 'Outstanding Loans';
    }
}

function animateCountUp(el, newValue, prefix = 'KES ') {
    if (!el) return;
    const prevTarget = Number(el.getAttribute('data-target') || 0);
    const target = Number(newValue) || 0;
    el.setAttribute('data-target', target);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.innerHTML = `${prefix}${target.toLocaleString('en-KE')}`;
        return;
    }
    const duration = 700;
    const start = performance.now();
    const from = isFinite(prevTarget) ? prevTarget : 0;
    function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 4);
        const current = Math.round(from + (target - from) * eased);
        el.innerHTML = `${prefix}${current.toLocaleString('en-KE')}`;
        if (progress < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

function toggleWalletScopeMenu() {
    const menu = document.getElementById('walletScopeMenu');
    if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function setWalletScope(scope) {
    walletScope = scope;
    document.getElementById('walletScopeLabel').textContent = scope === 'mine' ? '👤 Mine' : '🧺 Group';
    document.getElementById('walletScopeMenu').style.display = 'none';
    renderWalletBalance();
}

document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('walletScopeChip')?.closest('.wallet-scope-wrapper');
    const menu = document.getElementById('walletScopeMenu');
    if (wrapper && menu && menu.style.display !== 'none' && !wrapper.contains(e.target)) {
        menu.style.display = 'none';
    }
});

function getUserStats(username) {
    const stats = { savings: 0, loans: 0, repaid: 0, net: 0 };
    allRecords.forEach(r => {
        if (r.member === username) {
            if (r.type === 'Savings') stats.savings += r.amount;
            else if (r.type === 'Loan Taken') stats.loans += r.amount;
            else if (r.type === 'Loan Repayment') stats.repaid += r.amount;
        }
    });
    stats.net = stats.savings - stats.loans + stats.repaid;
    return stats;
}

function updateMemberDropdowns() {
    const memberSelect = document.getElementById('memberSelect');
    const filterMember = document.getElementById('filterMember');
    if (memberSelect) {
        memberSelect.innerHTML = `<option value="${currentUser}">${escapeHtml(currentUser)}</option>`;
        memberSelect.disabled = true;
    }
}

// ============================================================
// RENDER FUNCTIONS
// ============================================================
function renderRecentActivity() {
    const container = document.getElementById('recentActivityList');
    if (!container) return;
    if (!allRecords.length) {
        container.innerHTML = '<div class="empty-state">No transactions yet</div>';
        return;
    }
    const recent = [...allRecords].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    const iconFor = (type) => type === 'Savings' ? '💰' : type === 'Loan Taken' ? '🏦' : '🔄';
    container.innerHTML = recent.map(r => {
        const sign = r.type === 'Loan Taken' ? '-' : '+';
        return `<div class="activity-row">
            <div class="activity-icon">${iconFor(r.type)}</div>
            <div class="activity-info">
                <div class="activity-name">${escapeHtml(r.member)}</div>
                <div class="activity-meta">${r.type} · ${new Date(r.date).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })}</div>
            </div>
            <div class="activity-amount ${sign === '-' ? 'negative' : 'positive'}">${sign} KES ${(r.amount || 0).toLocaleString('en-KE')}</div>
        </div>`;
    }).join('');
}

function renderPendingLoans() {
    const container = document.getElementById('pendingLoans');
    if (!container) return;
    if (!pendingLoans.length) { container.innerHTML = '<div class="empty-state">No pending loan approvals</div>'; return; }
    container.innerHTML = pendingLoans.map(loan => {
        const isRequester = (loan.member === currentUser);
        const alreadyApproved = loan.approvals.includes(currentUser);
        const showButtons = !isRequester && !alreadyApproved && (isTreasurer() || isDeveloper());
        const totalNeeded = Math.max(allMembers.length - 1, 1);
        const percent = totalNeeded > 0 ? (loan.approvals.length / totalNeeded) * 100 : 100;
        return `<div class="loan-item ${isRequester ? 'own-loan' : ''}">
            <div><strong>${escapeHtml(loan.member)}</strong> requested <strong>KES ${(loan.principal || 0).toLocaleString('en-KE')}</strong> + 10% = <strong>KES ${(loan.totalDue || 0).toLocaleString('en-KE')}</strong>${isRequester ? ' (Your request)' : (alreadyApproved ? ' (You approved)' : '')}</div>
            <div style="font-size:12px;">${escapeHtml(loan.message || '')}</div>
            <div style="font-size:11px; margin-top:5px;">Approvals: ${loan.approvals.length}/${totalNeeded}</div>
            <div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(percent, 100)}%;"></div></div>
            ${showButtons ? `<div style="margin-top:8px; display:flex; gap:8px;"><button class="approve-btn" onclick="approveLoan('${loan.id}')">Approve</button><button class="reject-btn" onclick="rejectLoan('${loan.id}')">Reject</button></div>` : ''}
            ${isRequester && loan.status === 'pending' ? `<div style="margin-top:8px;"><button class="cancel-btn" onclick="cancelLoanRequest('${loan.id}')">❌ Cancel Request</button></div>` : ''}
        </div>`;
    }).join('');
}

function renderCompletedLoans() {
    const container = document.getElementById('completedLoans');
    if (!container) return;
    if (!completedLoans.length) { container.innerHTML = '<div class="empty-state">No completed loans yet</div>'; return; }
    container.innerHTML = completedLoans.map(loan =>
        `<div class="completed-loan-item">
            <div><strong>${escapeHtml(loan.member)}</strong> borrowed <strong>KES ${(loan.principal || 0).toLocaleString('en-KE')}</strong></div>
            <div>Interest: KES ${(loan.interest || 0).toLocaleString('en-KE')}</div>
            <div><strong>Total Due: KES ${(loan.totalDue || 0).toLocaleString('en-KE')}</strong></div>
            <div style="font-size:10px;">Approved by: ${escapeHtml(loan.approvals.join(', '))}</div>
        </div>`
    ).join('');
}

function renderActiveLoans() {
    const container = document.getElementById('activeLoansList');
    if (!container) return;
    const stillOwed = activeLoans.filter(l => l.status !== 'paid_off');
    if (!stillOwed.length) { container.innerHTML = '<div class="empty-state">No active loans right now</div>'; return; }
    container.innerHTML = stillOwed.map(loan => {
        const isMine = loan.member === currentUser;
        const overdueClass = loan.isOverdue ? 'loan-overdue' : '';
        const progressPct = loan.totalDue > 0 ? Math.min(100, (loan.amountRepaid / loan.totalDue) * 100) : 0;
        return `<div class="active-loan-item ${overdueClass} ${isMine ? 'own-loan' : ''}">
            <div class="active-loan-header"><strong>${escapeHtml(loan.member)}</strong>${loan.isOverdue ? '<span class="overdue-badge">⚠️ Overdue</span>' : ''}</div>
            <div class="active-loan-amounts"><span>Owed: KES ${loan.remaining.toLocaleString('en-KE')}</span><span class="active-loan-total">of KES ${loan.totalDue.toLocaleString('en-KE')}</span></div>
            <div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%;"></div></div>
            <div class="active-loan-due">📅 Due: ${loan.dueDate || 'Not set'}</div>
        </div>`;
    }).join('');
}

function renderLoansAwaitingDueDate() {
    const container = document.getElementById('awaitingDueDateList');
    const card = document.getElementById('awaitingDueDateCard');
    if (!container) return;
    if (card) card.style.display = (isTreasurer() || isDeveloper()) ? 'block' : 'none';
    if (!isTreasurer() && !isDeveloper()) return;
    if (!loansAwaitingDueDate.length) {
        container.innerHTML = '<div class="empty-state">No loans waiting on a due date</div>';
        return;
    }
    container.innerHTML = loansAwaitingDueDate.map(loan => {
        const interest = Math.round((loan.principal || 0) * 0.10);
        const totalDue = (loan.principal || 0) + interest;
        return `<div class="loan-item">
            <div><strong>${escapeHtml(loan.member)}</strong> — KES ${(loan.principal || 0).toLocaleString('en-KE')} + 10% = <strong>KES ${totalDue.toLocaleString('en-KE')}</strong></div>
            <div style="font-size:12px; margin-top:4px;">${escapeHtml(loan.message || '')}</div>
            <div class="form-grid" style="margin-top:10px; margin-bottom:8px;">
                <div><label>📅 Repayment Due Date</label><input type="date" id="dueDateInput-${loan.id}"></div>
            </div>
            <button onclick="submitLoanDueDate('${loan.id}')" style="width:auto; padding:8px 16px;">Set Due Date &amp; Activate</button>
        </div>`;
    }).join('');
}

function renderPendingApprovals() {
    const container = document.getElementById('pendingApprovalsList');
    if (!container) return;
    if (!pendingTransactions.length) { container.innerHTML = '<div class="empty-state">No pending approvals</div>'; return; }
    container.innerHTML = pendingTransactions.map(t => {
        const editKey = `${t.member}|${t.type}|${t.amount}`;
        const editInfo = pendingEditsMap[editKey];
        const editBadge = editInfo ? `<div style="background:var(--blue-soft);color:var(--blue);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;margin-bottom:8px;display:inline-block;">✏️ EDIT REQUEST — was KES ${editInfo.originalAmount.toLocaleString('en-KE')}</div><br>` : '';
        const rejectFn = editInfo ? `rejectTransactionEdit('${editInfo.editId}', '${currentUser}')` : `rejectTransaction('${t.id}')`;
        return `<div class="pending-item">
            ${editBadge}
            <div><strong>📅 ${t.date}</strong></div>
            <div>👤 <strong>Submitted by:</strong> ${escapeHtml(t.submittedBy || t.member)}</div>
            <div>💰 <strong>Type:</strong> ${t.type}</div>
            <div>💵 <strong>Amount:</strong> KES ${(t.amount || 0).toLocaleString('en-KE')}</div>
            <div>💬 <strong>Message:</strong> ${escapeHtml(t.message || '-')}</div>
            <div style="margin-top: 10px; display: flex; gap: 8px;">
                <button class="approve-btn" onclick="approveTransaction('${t.id}')">✅ Approve</button>
                <button class="reject-btn" onclick="${rejectFn}">❌ Reject</button>
            </div>
        </div>`;
    }).join('');
}

function updatePendingCount() {
    const spans = [document.getElementById('pendingCount'), document.getElementById('pendingCountSidebar')];
    spans.forEach(span => {
        if (!span) return;
        if (pendingTransactions.length > 0) {
            span.textContent = ` ${pendingTransactions.length}`;
            span.classList.add('visible');
        } else {
            span.textContent = '';
            span.classList.remove('visible');
        }
    });
}

// ============================================================
// TRANSACTION FUNCTIONS
// ============================================================
function openAddTransactionModal(type) {
    const modal = document.getElementById('addTransactionModal');
    if (!modal) return;
    document.getElementById('type').value = type;
    document.getElementById('addTransactionTitle').textContent = 
        type === 'Savings' ? '💰 New Deposit' : type === 'Loan Taken' ? '🏦 Request a Loan' : '🔄 Repay a Loan';
    toggleApprovalNotice();
    if (!document.getElementById('date').value) {
        document.getElementById('date').value = new Date().toISOString().split('T')[0];
    }
    modal.style.display = 'flex';
}

function closeAddTransactionModal() {
    document.getElementById('addTransactionModal').style.display = 'none';
}

function toggleApprovalNotice() {
    const type = document.getElementById('type').value;
    document.getElementById('approvalNotice').style.display = type === 'Loan Taken' ? 'block' : 'none';
    const pickerWrapper = document.getElementById('repayLoanPickerWrapper');
    const amountHint = document.getElementById('amountHint');
    if (pickerWrapper) {
        pickerWrapper.style.display = type === 'Loan Repayment' ? 'block' : 'none';
        if (type === 'Loan Repayment') {
            populateRepayLoanPicker();
            if (amountHint) amountHint.textContent = 'You can pay any amount — partial payments are fine.';
        } else if (amountHint) {
            amountHint.textContent = 'For loans: Enter PRINCIPAL amount (10% interest added)';
        }
    }
}

function populateRepayLoanPicker() {
    const picker = document.getElementById('repayLoanPicker');
    if (!picker) return;
    const myLoans = activeLoans.filter(l => l.member === currentUser && l.status !== 'paid_off');
    if (!myLoans.length) {
        picker.innerHTML = '<option value="">You have no active loans</option>';
        return;
    }
    picker.innerHTML = myLoans.map(l =>
        `<option value="${l.loanId}">KES ${l.remaining.toLocaleString('en-KE')} owed (due ${l.dueDate || 'not set'})${l.isOverdue ? ' — OVERDUE' : ''}</option>`
    ).join('');
}

async function addRecord() {
    if (!currentUser) { showToast('Please login first', 'error'); return; }
    const date = document.getElementById('date').value;
    const member = currentUser;
    const type = document.getElementById('type').value;
    const amount = parseFloat(document.getElementById('amount').value);
    const message = document.getElementById('message').value;
    if (!date || !amount || amount <= 0) { showToast('Please fill all fields', 'error'); return; }
    const btn = document.getElementById('addBtn');
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Processing...');
    if (type === 'Loan Taken') {
        const savingsRes = await callAPI('getSummary');
        const currentSavings = savingsRes.success ? (savingsRes.savings || 0) : 0;
        if (amount > currentSavings) {
            showToast(`Cannot borrow KES ${amount.toLocaleString()}. Available: KES ${currentSavings.toLocaleString()}`, 'error');
            hideButtonLoading(btn, orig);
            return;
        }
        const res = await callAPI('submitLoan', { date, member, amount, message, notes: '', requestedBy: currentUser });
        if (res.success) {
            showToast(`Loan request submitted! Needs ${Math.max(allMembers.length - 1, 1)} other approvals.`, 'success');
            document.getElementById('amount').value = '';
            document.getElementById('message').value = '';
            closeAddTransactionModal();
            await loadAllData();
        } else showToast('Error: ' + res.error, 'error');
    } else {
        let loanId = '';
        if (type === 'Loan Repayment') {
            const picker = document.getElementById('repayLoanPicker');
            loanId = picker ? picker.value : '';
            if (!loanId) {
                showToast('Please choose which loan you are repaying', 'error');
                hideButtonLoading(btn, orig);
                return;
            }
        }
        const res = await callAPI('submitTransaction', { date, member, type, amount, message, submittedBy: currentUser, loanId });
        if (res.success) {
            showToast(`Transaction submitted! Waiting for ${TREASURER_NAME} approval.`, 'success');
            document.getElementById('amount').value = '';
            document.getElementById('message').value = '';
            closeAddTransactionModal();
            await loadAllData();
        } else showToast('Error: ' + (res.error || 'Failed'), 'error');
    }
    hideButtonLoading(btn, orig);
}

async function approveTransaction(id) {
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Approving...');
    const res = await callAPI('approveTransaction', { id, approvedBy: currentUser });
    if (res.success) { showToast('Transaction approved!', 'success'); await loadAllData(); }
    else { showToast(res.error || 'Error', 'error'); }
    hideButtonLoading(btn, orig);
}

async function rejectTransaction(id) {
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Rejecting...');
    const res = await callAPI('rejectTransaction', { id });
    if (res.success) { showToast('Transaction rejected', 'success'); await loadAllData(); }
    else { showToast(res.error || 'Error', 'error'); }
    hideButtonLoading(btn, orig);
}

async function rejectTransactionEdit(editId, rejectedBy) {
    const btn = event?.target;
    const orig = btn?.innerHTML;
    if (btn) showButtonLoading(btn, 'Rejecting...');
    const res = await callAPI('rejectTransactionEdit', { editId, rejectedBy: currentUser });
    if (res.success) {
        showToast('Edit request rejected — original restored', 'success');
        await loadAllData();
    } else {
        showToast(res.error || 'Error rejecting edit', 'error');
    }
    if (btn) hideButtonLoading(btn, orig);
}

// ============================================================
// LOAN FUNCTIONS
// ============================================================
async function approveLoan(loanId) {
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Approving...');
    const res = await callAPI('approveLoan', { loanId, approver: currentUser });
    if (res.success) {
        const remaining = Math.max((allMembers.length - 1) - (res.approvals || 0), 0);
        showToast(remaining > 0 ? `Approved! Need ${remaining} more` : `Loan fully approved!`, 'success');
        await loadAllData();
    } else { showToast('Error: ' + res.error, 'error'); }
    hideButtonLoading(btn, orig);
}

async function rejectLoan(loanId) {
    const res = await callAPI('rejectLoan', { loanId });
    if (res.success) { showToast('Loan rejected', 'success'); await loadAllData(); }
    else showToast('Error: ' + res.error, 'error');
}

async function cancelLoanRequest(loanId) {
    if (!confirm('Cancel this loan request?')) return;
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Cancelling...');
    const res = await callAPI('cancelLoan', { loanId });
    if (res.success) { showToast('Loan cancelled!', 'success'); await loadAllData(); }
    else showToast(res.error || 'Error', 'error');
    hideButtonLoading(btn, orig);
}

async function submitLoanDueDate(loanId) {
    const input = document.getElementById(`dueDateInput-${loanId}`);
    const dueDate = input ? input.value : '';
    if (!dueDate) {
        showToast('Please choose a due date', 'error');
        return;
    }
    const res = await callAPI('setLoanDueDate', { loanId, dueDate, setBy: currentUser });
    if (res.success) {
        showToast('Loan activated with due date set!', 'success');
        await loadAllData();
    } else {
        showToast(res.error || 'Error setting due date', 'error');
    }
}

// ============================================================
// MEETING FUNCTIONS
// ============================================================
async function loadMeetingMinutes() {
    const container = document.getElementById('meetingMinutesList');
    if (!container) return;
    const res = await callAPI('getMeetingMinutes');
    if (res.success && res.meetings) {
        const meetings = res.meetings;
        if (meetings.length === 0) {
            container.innerHTML = '<div class="empty-state">No meeting minutes recorded yet.</div>';
            return;
        }
        container.innerHTML = meetings.slice().reverse().map(meeting => {
            let countdownHtml = '';
            if (meeting.nextMeeting) countdownHtml = `<div class="countdown-timer" data-date="${meeting.nextMeeting}">📅 Loading countdown...</div>`;
            return `<div class="meeting-item">
                <div class="meeting-header"><span class="meeting-date">📅 ${escapeHtml(meeting.date)}</span><span class="meeting-author">by ${escapeHtml(meeting.recordedBy)}</span></div>
                <div class="meeting-section"><div class="meeting-section-title">📋 Agenda:</div><div class="meeting-section-content">${escapeHtml(meeting.agenda)}</div></div>
                <div class="meeting-section"><div class="meeting-section-title">📝 Notes:</div><div class="meeting-section-content">${escapeHtml(meeting.notes || 'No notes')}</div></div>
                <div class="meeting-section"><div class="meeting-section-title">✅ Decisions:</div><div class="meeting-section-content">${escapeHtml(meeting.decisions || 'None')}</div></div>
                ${meeting.nextMeeting ? `<div class="meeting-section"><div class="meeting-section-title">📅 Next Meeting:</div><div class="meeting-section-content">${escapeHtml(meeting.nextMeeting)}</div>${countdownHtml}</div>` : ''}
                ${isTreasurer() || isDeveloper() ? `<button class="delete-meeting-btn" onclick="deleteMeeting('${meeting.id}')">🗑️ Delete Meeting</button>` : ''}
            </div>`;
        }).join('');
        updateCountdowns();
        startCountdown();
    }
}

function openViewMinutesModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
            <h3 style="margin:0;">📝 Meeting Minutes</h3>
            <button onclick="openAddMeetingModal()" style="width:auto; padding:7px 14px; font-size:12px;">+ Add</button>
        </div>
        <div id="meetingMinutesList" class="loading-container"><div class="loading-spinner"></div><div>Loading...</div></div>
        <div class="modal-buttons"><button class="close-modal" onclick="this.closest('.modal').remove()">Close</button></div>
    </div>`;
    document.body.appendChild(modal);
    loadMeetingMinutes();
}

function openAddMeetingModal() {
    const today = new Date().toISOString().split('T')[0];
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <h3>📝 Add Meeting Minutes</h3>
        <div class="form-grid">
            <div><label>Meeting Date</label><input type="date" id="meetingDate" value="${today}"></div>
            <div><label>Recorded By</label><input type="text" id="meetingRecordedBy" value="${currentUser}" readonly></div>
            <div style="grid-column: span 2;"><label>Agenda *</label><textarea id="meetingAgenda" rows="2"></textarea></div>
            <div style="grid-column: span 2;"><label>Notes</label><textarea id="meetingNotes" rows="3"></textarea></div>
            <div style="grid-column: span 2;"><label>Decisions Made</label><textarea id="meetingDecisions" rows="2"></textarea></div>
            <div><label>Next Meeting Date</label><input type="date" id="meetingNext"></div>
        </div>
        <div class="modal-buttons"><button onclick="saveMeetingMinutes()">Save</button><button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button></div>
    </div>`;
    document.body.appendChild(modal);
}

async function saveMeetingMinutes() {
    const date = document.getElementById('meetingDate').value;
    const agenda = document.getElementById('meetingAgenda').value.trim();
    if (!date || !agenda) { showToast('Please fill required fields', 'error'); return; }
    const res = await callAPI('saveMeetingMinutes', {
        date,
        recordedBy: currentUser,
        agenda,
        notes: document.getElementById('meetingNotes').value,
        decisions: document.getElementById('meetingDecisions').value,
        nextMeeting: document.getElementById('meetingNext').value
    });
    if (res.success) {
        showToast('Meeting saved!', 'success');
        document.getElementById('meetingDate')?.closest('.modal')?.remove();
        await loadMeetingMinutes();
    } else showToast('Error: ' + res.error, 'error');
}

async function deleteMeeting(id) {
    if (!confirm('Delete this meeting?')) return;
    const res = await callAPI('deleteMeeting', { id });
    if (res.success) { showToast('Meeting deleted!', 'success'); await loadMeetingMinutes(); }
    else showToast('Error deleting meeting', 'error');
}

// ============================================================
// SCHEDULED MEETING
// ============================================================
async function loadScheduledMeeting() {
    try {
        const res = await callAPI('getScheduledMeeting');
        const card = document.getElementById('upcomingMeetingCard');
        const info = document.getElementById('upcomingMeetingInfo');
        if (res.success && res.meeting && res.meeting.date) {
            card.style.display = 'block';
            info.innerHTML = `
                <div class="meeting-item" style="border-left-color: #3B6FF2; background: #F4F6FB;">
                    <div class="meeting-header"><span class="meeting-date">📅 ${escapeHtml(res.meeting.date)}</span></div>
                    <div class="meeting-section"><div class="meeting-section-title">📋 Agenda:</div><div class="meeting-section-content">${escapeHtml(res.meeting.agenda || 'Not set')}</div></div>
                    <div class="meeting-section"><div class="meeting-section-title">📍 Venue:</div><div class="meeting-section-content">${escapeHtml(res.meeting.venue || 'Not set')}</div></div>
                    <div class="countdown-timer" data-date="${res.meeting.date}">📅 Loading countdown...</div>
                    <div class="meeting-section" style="margin-top: 10px;"><div class="meeting-section-title">📅 Scheduled by:</div><div class="meeting-section-content">${escapeHtml(res.meeting.scheduledBy || 'Unknown')}</div></div>
                    ${isTreasurer() || isDeveloper() ? `<button class="delete-meeting-btn" onclick="cancelScheduledMeeting()" style="margin-top: 10px;">🗑️ Cancel Schedule</button>` : ''}
                </div>
            `;
            updateCountdowns();
            startCountdown();
        } else {
            card.style.display = 'none';
        }
    } catch (e) {
        console.error('Error loading scheduled meeting:', e);
    }
}

function openScheduleMeetingModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <h3>📅 Schedule Next Meeting</h3>
        <div class="form-grid">
            <div><label>📅 Next Meeting Date</label><input type="date" id="nextMeetingDate"></div>
            <div><label>📋 Meeting Agenda</label><input type="text" id="nextMeetingAgenda" placeholder="What will be discussed?"></div>
            <div><label>📍 Venue / Location</label><input type="text" id="nextMeetingVenue" placeholder="e.g., Online / Hall"></div>
        </div>
        <div class="modal-buttons">
            <button id="scheduleMeetingBtn" onclick="scheduleNextMeetingAndClose()">📅 Schedule</button>
            <button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
}

async function scheduleNextMeetingAndClose() {
    await scheduleNextMeeting();
    const dateInput = document.getElementById('nextMeetingDate');
    if (dateInput && dateInput.value === '') {
        dateInput.closest('.modal')?.remove();
    }
}

async function scheduleNextMeeting() {
    const date = document.getElementById('nextMeetingDate').value;
    const agenda = document.getElementById('nextMeetingAgenda').value;
    const venue = document.getElementById('nextMeetingVenue').value;
    if (!date) { showToast('Please select a meeting date', 'error'); return; }
    const btn = document.getElementById('scheduleMeetingBtn');
    const originalText = btn.innerHTML;
    showButtonLoading(btn, 'Scheduling...');
    const res = await callAPI('scheduleMeeting', { date, agenda, venue, scheduledBy: currentUser });
    if (res.success) {
        showToast('Next meeting scheduled!', 'success');
        document.getElementById('nextMeetingDate').value = '';
        document.getElementById('nextMeetingAgenda').value = '';
        document.getElementById('nextMeetingVenue').value = '';
        await loadScheduledMeeting();
    } else {
        showToast(res.error || 'Error scheduling meeting', 'error');
    }
    hideButtonLoading(btn, originalText);
}

async function cancelScheduledMeeting() {
    if (!confirm('Cancel the scheduled meeting?')) return;
    const res = await callAPI('cancelScheduledMeeting');
    if (res.success) { showToast('Scheduled meeting cancelled', 'success'); await loadScheduledMeeting(); }
    else showToast('Error cancelling meeting', 'error');
}

function updateCountdowns() {
    const els = document.querySelectorAll('.countdown-timer[data-date]');
    const now = new Date();
    els.forEach(el => {
        const target = new Date(el.getAttribute('data-date'));
        const diff = target - now;
        if (diff <= 0) { el.innerHTML = '🎉 Meeting is today!'; el.classList.add('urgent'); }
        else {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % 86400000) / (1000 * 60 * 60));
            const mins = Math.floor((diff % 3600000) / (1000 * 60));
            if (days > 0) el.innerHTML = `📅 Countdown: ${days}d ${hours}h`;
            else if (hours > 0) { el.innerHTML = `⏰ Countdown: ${hours}h ${mins}m`; el.classList.add('urgent'); }
            else { el.innerHTML = `⏰ Countdown: ${mins}m`; el.classList.add('urgent'); }
        }
    });
}

function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    updateCountdowns();
    countdownInterval = setInterval(updateCountdowns, 60000);
}

// ============================================================
// ANNOUNCEMENTS
// ============================================================
function openSendAnnouncementModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <h3>📢 Send Announcement</h3>
        <div class="form-grid">
            <div style="grid-column: span 2;"><label>Title</label><input type="text" id="announcementTitle" placeholder="e.g., Meeting moved to 6pm" maxlength="80"></div>
            <div style="grid-column: span 2;"><label>Message</label><textarea id="announcementBody" rows="3" placeholder="Write your announcement here..." maxlength="500"></textarea></div>
        </div>
        <div class="modal-buttons">
            <button id="sendAnnouncementBtn" onclick="sendAnnouncementAndClose()">📢 Send to All</button>
            <button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button>
        </div>
    </div>`;
    document.body.appendChild(modal);
}

async function sendAnnouncementAndClose() {
    await sendAnnouncement();
    const titleInput = document.getElementById('announcementTitle');
    if (titleInput && titleInput.value === '') {
        titleInput.closest('.modal')?.remove();
    }
}

async function sendAnnouncement() {
    const titleInput = document.getElementById('announcementTitle').value.trim();
    const bodyInput = document.getElementById('announcementBody').value.trim();
    if (!bodyInput) { showToast('Please write a message', 'error'); return; }
    const btn = document.getElementById('sendAnnouncementBtn');
    const originalText = btn.innerHTML;
    showButtonLoading(btn, 'Sending...');
    const title = titleInput ? `📢 ${titleInput}` : `📢 Announcement from ${currentUser}`;
    const body = `${bodyInput} — sent by ${currentUser}`;
    const res = await callAPI('sendPushNotification', { title, body, sender: currentUser });
    if (res.success) {
        const sent = res.sent || 0;
        showToast(sent > 0 ? `Announcement sent to ${sent} member${sent > 1 ? 's' : ''}!` : 'No other members are subscribed yet', 'success');
        document.getElementById('announcementTitle').value = '';
        document.getElementById('announcementBody').value = '';
    } else {
        showToast(res.error || 'Error sending announcement', 'error');
    }
    hideButtonLoading(btn, originalText);
}

// ============================================================
// AUDIT LOG
// ============================================================
function openAuditLogModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <h3 style="margin-bottom:14px;">📋 Activity Log</h3>
        <div id="auditLogList" class="loading-container"><div class="loading-spinner"></div><div>Loading...</div></div>
        <div class="modal-buttons"><button class="close-modal" onclick="this.closest('.modal').remove()">Close</button></div>
    </div>`;
    document.body.appendChild(modal);
    loadAuditLog();
}

async function loadAuditLog() {
    const container = document.getElementById('auditLogList');
    if (!container) return;
    const res = await callAPI('getAuditLog', { limit: 50 });
    if (!res.success || !res.entries?.length) {
        container.innerHTML = '<div class="empty-state">No activity recorded yet</div>';
        return;
    }
    container.innerHTML = res.entries.map(e => {
        const when = e.timestamp ? new Date(e.timestamp) : null;
        const whenStr = when && !isNaN(when) ? when.toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
        return `<div class="audit-log-row">
            <div class="audit-log-icon">${auditIconFor(e.action)}</div>
            <div class="audit-log-info">
                <div class="audit-log-line"><strong>${escapeHtml(e.actor)}</strong> ${escapeHtml(e.action)}</div>
                ${e.details ? `<div class="audit-log-details">${escapeHtml(e.details)}</div>` : ''}
                <div class="audit-log-time">${whenStr}</div>
            </div>
        </div>`;
    }).join('');
}

// ============================================================
// MEMBERS LIST
// ============================================================
async function loadMembersList() {
    const container = document.getElementById('membersList');
    if (!container) return;
    try {
        const res = await callAPI('getMembersWithImages');
        if (res.success && res.members && res.members.length > 0) {
            allMembersData = res.members;
            renderMembersList(allMembersData);
            document.getElementById('memberCountBadge').textContent = `${allMembersData.length} Members`;
        } else {
            container.innerHTML = '<div class="empty-state">No members found.</div>';
            document.getElementById('memberCountBadge').textContent = '0 Members';
        }
        updateAboutStats();
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading members</div>';
    }
}

function renderMembersList(members) {
    const container = document.getElementById('membersList');
    if (!container) return;
    if (!members || members.length === 0) {
        container.innerHTML = '<div class="empty-state">No members found</div>';
        return;
    }
    const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));
    container.innerHTML = sortedMembers.map(member => {
        const initial = getInitials(member.name);
        const isTreas = member.name === TREASURER_NAME;
        const memberStats = getUserStats(member.name);
        const cachedPhoto = memberPhotoCache[member.email?.toLowerCase()];
        const avatarContent = cachedPhoto ? `<img src="${cachedPhoto}" alt="${escapeHtml(member.name)}">` : initial;
        return `<div class="member-card" onclick="viewMemberProfile('${escapeHtml(member.name)}', '${escapeHtml(member.email || '')}')">
            <div class="member-avatar" id="memberAvatar-${escapeHtml(member.email || '')}">${avatarContent}</div>
            <div class="member-card-info">
                <div class="member-name">${escapeHtml(member.name)}</div>
                <div class="member-role ${isTreas ? 'treasurer' : ''}">${isTreas ? '👑 Treasurer' : 'Member'}</div>
            </div>
            <div class="member-stats">
                <span>💰 KES ${(memberStats.savings || 0).toLocaleString()}</span>
                <span>🏦 KES ${(memberStats.loans || 0).toLocaleString()}</span>
            </div>
        </div>`;
    }).join('');
    let photoFetchDelay = 0;
    sortedMembers.forEach(member => {
        if (!member.hasImage || !member.email) return;
        const emailKey = member.email.toLowerCase();
        if (memberPhotoCache[emailKey]) return;
        setTimeout(() => loadMemberPhoto(member.email), photoFetchDelay);
        photoFetchDelay += 200;
    });
}

async function loadMemberPhoto(email) {
    try {
        const res = await callAPI('getProfileImage', { email });
        if (res.success && res.image) {
            memberPhotoCache[email.toLowerCase()] = res.image;
            const avatarEl = document.getElementById(`memberAvatar-${email}`);
            if (avatarEl) avatarEl.innerHTML = `<img src="${res.image}" alt="${escapeHtml(email)}">`;
        }
    } catch (e) { console.error('Failed to load photo for', email, e); }
}

function viewMemberProfile(name, email) {
    const member = allMembersData.find(m => m.name === name);
    if (!member) { showToast('Member not found', 'error'); return; }
    const stats = getUserStats(name);
    const isTreas = name === TREASURER_NAME;
    const initial = getInitials(name);
    const cachedPhoto = email ? memberPhotoCache[email.toLowerCase()] : null;
    const avatarId = `profileViewAvatar-${email || name}`;
    const overlay = document.createElement('div');
    overlay.className = 'profile-modal-overlay';
    overlay.onclick = function(e) { if (e.target === this) this.remove(); };
    overlay.innerHTML = `
        <div class="profile-modal">
            <div class="profile-cover">
                <div class="profile-avatar-wrapper">
                    <div class="profile-avatar" id="${avatarId}" style="cursor: default;">
                        ${cachedPhoto ? `<img src="${cachedPhoto}" alt="${escapeHtml(name)}">` : initial}
                    </div>
                </div>
            </div>
            <div class="profile-body">
                <div class="profile-name">${escapeHtml(name)}</div>
                <div class="profile-email">${escapeHtml(email || 'No email')}</div>
                <span class="profile-role ${isTreas ? 'treasurer' : ''}">${isTreas ? '👑 Treasurer' : '👤 Member'}</span>
                <div class="profile-divider"></div>
                <div class="profile-stats-grid">
                    <div class="profile-stat-card savings"><div class="stat-number">KES ${(stats.savings || 0).toLocaleString()}</div><div class="stat-label">Total Savings</div></div>
                    <div class="profile-stat-card loans"><div class="stat-number">KES ${(stats.loans || 0).toLocaleString()}</div><div class="stat-label">Total Loans</div></div>
                    <div class="profile-stat-card repaid"><div class="stat-number">KES ${(stats.repaid || 0).toLocaleString()}</div><div class="stat-label">Total Repaid</div></div>
                    <div class="profile-stat-card net"><div class="stat-number">KES ${(stats.net || 0).toLocaleString()}</div><div class="stat-label">Net Balance</div></div>
                </div>
                <div class="profile-divider"></div>
                <div class="profile-actions"><button class="btn-close" onclick="this.closest('.profile-modal-overlay').remove()">Close</button></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    if (member.hasImage && email && !cachedPhoto) {
        callAPI('getProfileImage', { email }).then(res => {
            if (res.success && res.image) {
                memberPhotoCache[email.toLowerCase()] = res.image;
                const avatarEl = document.getElementById(avatarId);
                if (avatarEl) avatarEl.innerHTML = `<img src="${res.image}" alt="${escapeHtml(name)}">`;
            }
        }).catch(e => console.error('Failed to load photo', e));
    }
}

function updateAboutStats() {
    const membersEl = document.getElementById('aboutStatMembers');
    const savingsEl = document.getElementById('aboutStatSavings');
    const txnsEl = document.getElementById('aboutStatTxns');
    if (membersEl) membersEl.textContent = allMembersData.length || 0;
    if (txnsEl) txnsEl.textContent = allRecords.length || 0;
    if (savingsEl) {
        const totalSaved = allRecords.filter(r => r.type === 'Savings').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        savingsEl.textContent = totalSaved >= 1000 ? `${(totalSaved / 1000).toFixed(1)}K` : totalSaved.toLocaleString('en-KE');
    }
}

// ============================================================
// HISTORY MODAL
// ============================================================
let currentHistoryRecords = [];

function openHistoryModal() {
    const modal = document.createElement('div');
    modal.className = 'history-modal';
    modal.innerHTML = `
        <div class="history-modal-content">
            <div class="history-modal-header">
                <h3>📜 Transaction History</h3>
                <button class="close-history-btn" onclick="this.closest('.history-modal').remove()">✕</button>
            </div>
            <div class="history-modal-body">
                <div class="history-search">
                    <input type="text" id="historySearch" placeholder="Search...">
                    <select id="historyFilterMember"><option value="">All Members</option>${allMembers.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                    <select id="historyFilterType"><option value="">All Types</option><option value="Savings">Savings</option><option value="Loan Taken">Loan Taken</option><option value="Loan Repayment">Loan Repayment</option></select>
                </div>
                <div style="overflow-x: auto; max-width: 100%;">
                    <table class="history-table">
                        <thead><tr><th onclick="sortHistory('date')">Date ⬍</th><th onclick="sortHistory('member')">Member ⬍</th><th onclick="sortHistory('type')">Type ⬍</th><th onclick="sortHistory('amount')">Amount ⬍</th><th>Message</th><th></th></tr></thead>
                        <tbody id="historyBody"></tbody>
                    </table>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    currentHistoryRecords = [...allRecords];
    renderHistoryTable();
    document.getElementById('historySearch')?.addEventListener('input', filterHistory);
    document.getElementById('historyFilterMember')?.addEventListener('change', filterHistory);
    document.getElementById('historyFilterType')?.addEventListener('change', filterHistory);
}

function filterHistory() {
    const search = document.getElementById('historySearch')?.value.toLowerCase() || '';
    const filterMember = document.getElementById('historyFilterMember')?.value || '';
    const filterType = document.getElementById('historyFilterType')?.value || '';
    let filtered = [...allRecords];
    if (filterMember) filtered = filtered.filter(r => r.member === filterMember);
    if (filterType) filtered = filtered.filter(r => r.type === filterType);
    if (search) filtered = filtered.filter(r => r.member.toLowerCase().includes(search) || (r.message || '').toLowerCase().includes(search));
    renderHistoryTable(filtered);
}

function sortHistory(column) { renderHistoryTable(); }

function renderHistoryTable(filtered = null) {
    const tbody = document.getElementById('historyBody');
    if (!tbody) return;
    const records = filtered || currentHistoryRecords;
    if (!records.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No transactions found</td></tr>'; return; }
    tbody.innerHTML = records.map(r => {
        let cls = r.type === 'Savings' ? 'badge-savings' : (r.type === 'Loan Taken' ? 'badge-loan' : 'badge-repayment');
        let sign = r.type === 'Loan Repayment' ? '+' : (r.type === 'Savings' ? '+' : '-');
        let msg = r.message || '-';
        const rowKey = `${r.date}|${r.member}|${r.type}|${r.amount}`;
        const isOwn = r.member === currentUser;
        const editBtn = isOwn ? `<button class="edit-txn-btn" onclick="openEditTransactionModal(${JSON.stringify(rowKey)}, ${JSON.stringify(r.type)}, ${r.amount}, ${JSON.stringify(r.message || '')})">✏️ Edit</button>` : '';
        return `<tr>
            <td style="white-space: nowrap;">${new Date(r.date).toLocaleDateString('en-KE')}</td>
            <td><strong>${escapeHtml(r.member)}</strong></td>
            <td><span class="badge ${cls}">${r.type}</span></td>
            <td style="white-space: nowrap;">${sign} KES ${(r.amount || 0).toLocaleString('en-KE')}</td>
            <td class="message-cell">${escapeHtml(msg)}</td>
            <td>${editBtn}</td>
        </tr>`;
    }).join('');
}

function openEditTransactionModal(rowKey, type, currentAmount, currentMessage) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h3>✏️ Request Edit</h3>
            <p style="font-size:12px; color:var(--ink-soft); margin-bottom:14px;">Editing a <strong>${escapeHtml(type)}</strong> transaction.</p>
            <div class="form-grid">
                <div style="grid-column:span 2;"><label>New Amount (KES)</label><input type="number" id="editTxnAmount" value="${currentAmount}" min="1"></div>
                <div style="grid-column:span 2;"><label>Updated Message</label><input type="text" id="editTxnMessage" value="${escapeHtml(currentMessage)}" placeholder="e.g., Bank/Mpesa Message"></div>
            </div>
            <div class="modal-buttons">
                <button onclick="submitTransactionEdit(${JSON.stringify(rowKey)})">Submit Edit Request</button>
                <button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button>
            </div>
        </div>`;
    document.body.appendChild(modal);
}

async function submitTransactionEdit(rowKey) {
    const newAmount = document.getElementById('editTxnAmount')?.value;
    const newMessage = document.getElementById('editTxnMessage')?.value || '';
    if (!newAmount || Number(newAmount) <= 0) { showToast('Please enter a valid amount', 'error'); return; }
    const res = await callAPI('requestTransactionEdit', { rowKey, member: currentUser, requestedBy: currentUser, newAmount: Number(newAmount), newMessage });
    if (res.success) {
        showToast('Edit request submitted! Awaiting approval.', 'success');
        document.querySelector('.modal .close-modal')?.closest('.modal')?.remove();
        document.querySelector('.history-modal')?.remove();
        await loadAllData(false, true);
    } else {
        showToast(res.error || 'Error submitting edit request', 'error');
    }
}

// ============================================================
// PROFILE MODAL
// ============================================================
function openProfileModal() {
    document.querySelectorAll('.profile-modal-overlay').forEach(el => el.remove());
    const userStats = getUserStats(currentUser);
    const initial = currentUser ? getInitials(currentUser) : '?';
    const profileImage = getProfileImage();
    const isTreas = isTreasurer();
    const isDev = isDeveloper();
    const overlay = document.createElement('div');
    overlay.className = 'profile-modal-overlay';
    overlay.onclick = function(e) { if (e.target === this) this.remove(); };
    overlay.innerHTML = `
        <div class="profile-modal">
            <div class="profile-cover">
                <div class="profile-avatar-wrapper">
                    <div class="profile-avatar" id="profileAvatar" onclick="document.getElementById('profileFileInput').click()">
                        ${profileImage ? `<img src="${profileImage}" alt="${currentUser}">` : initial}
                        <div class="avatar-overlay"><span class="camera-icon">📷</span><span>Change Photo</span></div>
                    </div>
                </div>
            </div>
            <div class="profile-body">
                <div class="profile-name">${escapeHtml(currentUser)}</div>
                <div class="profile-email">${escapeHtml(currentUserEmail)}</div>
                <span class="profile-role ${isTreas ? 'treasurer' : ''} ${isDev ? 'developer' : ''}">${isDev ? '🛠️ Developer' : isTreas ? '👑 Treasurer' : '👤 Member'}</span>
                <div class="profile-divider"></div>
                <div class="profile-stats-grid">
                    <div class="profile-stat-card savings"><div class="stat-number">KES ${userStats.savings.toLocaleString()}</div><div class="stat-label">Total Savings</div></div>
                    <div class="profile-stat-card loans"><div class="stat-number">KES ${userStats.loans.toLocaleString()}</div><div class="stat-label">Total Loans</div></div>
                    <div class="profile-stat-card repaid"><div class="stat-number">KES ${userStats.repaid.toLocaleString()}</div><div class="stat-label">Total Repaid</div></div>
                    <div class="profile-stat-card net"><div class="stat-number">KES ${userStats.net.toLocaleString()}</div><div class="stat-label">Net Balance</div></div>
                </div>
                <div class="profile-divider"></div>
                <div class="profile-actions">
                    <button class="btn-change-pwd" onclick="openChangePasswordModal(); document.querySelector('.profile-modal-overlay')?.remove();">🔐 Change Password</button>
                    <button class="btn-close" onclick="this.closest('.profile-modal-overlay').remove()">Close</button>
                </div>
                <div class="upload-progress" id="uploadProgress"><span id="uploadStatus">Uploading...</span><div class="progress-bar"><div class="progress-fill" id="uploadProgressFill"></div></div></div>
            </div>
            <input type="file" id="profileFileInput" class="profile-file-input" accept="image/*" onchange="handleProfileImageUpload(event)">
        </div>
    `;
    document.body.appendChild(overlay);
}

function getProfileImage() {
    return userProfileImage || localStorage.getItem('legacy_profile_image') || null;
}

async function saveProfileImageToServer(imageData) {
    try {
        const res = await callAPI('saveProfileImage', { email: currentUserEmail, image: imageData });
        if (res.success) {
            userProfileImage = imageData;
            localStorage.setItem('legacy_profile_image', imageData);
            updateHeaderAvatar();
            loadMembersList();
            return true;
        } else {
            showToast(res.error || 'Failed to save profile photo', 'error');
            return false;
        }
    } catch (e) {
        showToast('Error saving profile photo: ' + e.message, 'error');
        return false;
    }
}

async function handleProfileImageUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) { showToast('Please select an image file', 'error'); return; }
    const progressEl = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const statusEl = document.getElementById('uploadStatus');
    progressEl.classList.add('active');
    progressFill.style.width = '0%';
    statusEl.textContent = 'Reading image...';
    const reader = new FileReader();
    reader.onload = function(e) {
        statusEl.textContent = 'Processing...';
        progressFill.style.width = '75%';
        const img = new Image();
        img.onload = async function() {
            const canvas = document.createElement('canvas');
            const maxSize = 120;
            let width = img.width, height = img.height;
            if (width > height) { if (width > maxSize) { height = (height * maxSize) / width; width = maxSize; } }
            else { if (height > maxSize) { width = (width * maxSize) / height; height = maxSize; } }
            canvas.width = width; canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const compressedData = canvas.toDataURL('image/jpeg', 0.6);
            statusEl.textContent = 'Saving to server...';
            progressFill.style.width = '90%';
            const success = await saveProfileImageToServer(compressedData);
            if (success) {
                const avatar = document.getElementById('profileAvatar');
                if (avatar) avatar.innerHTML = `<img src="${compressedData}" alt="${currentUser}"><div class="avatar-overlay"><span class="camera-icon">📷</span><span>Change Photo</span></div>`;
                progressFill.style.width = '100%';
                statusEl.textContent = '✅ Done!';
                setTimeout(() => { progressEl.classList.remove('active'); progressFill.style.width = '0%'; }, 1500);
                showToast('Profile photo updated!', 'success');
            } else {
                statusEl.textContent = '❌ Failed to save';
                showToast('Failed to save profile photo.', 'error');
            }
        };
        img.src = e.target.result;
    };
    reader.onerror = function() { showToast('Error reading image', 'error'); progressEl.classList.remove('active'); };
    reader.readAsDataURL(file);
    event.target.value = '';
}

// ============================================================
// CHANGE PASSWORD
// ============================================================
function openChangePasswordModal() {
    document.querySelectorAll('.modal').forEach(el => el.remove());
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <h3>🔐 Change Password</h3>
        <div style="margin-bottom:16px;"><label>Current Password</label><input type="password" id="currentPassword" class="pin-input-field" placeholder="Enter current password"></div>
        <div style="margin-bottom:16px;"><label>New Password (min 6 characters)</label><input type="password" id="newPassword" class="pin-input-field" placeholder="Enter new password"></div>
        <div style="margin-bottom:16px;"><label>Confirm New Password</label><input type="password" id="confirmPassword" class="pin-input-field" placeholder="Confirm new password"></div>
        <div class="modal-buttons"><button onclick="changePassword()">Change Password</button><button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button></div>
    </div>`;
    document.body.appendChild(modal);
}

async function changePassword() {
    const cur = document.getElementById('currentPassword').value;
    const newPwd = document.getElementById('newPassword').value;
    const confirm = document.getElementById('confirmPassword').value;
    if (!cur || !newPwd || !confirm) { showToast('Please fill all fields', 'error'); return; }
    if (newPwd.length < 6) { showToast('New password must be at least 6 characters', 'error'); return; }
    if (newPwd !== confirm) { showToast('New passwords do not match', 'error'); return; }
    if (cur === newPwd) { showToast('New password must be different', 'error'); return; }
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Changing...');
    try {
        const res = await callAPI('changePassword', { email: currentUserEmail, oldPassword: cur, newPassword: newPwd });
        if (res.success) {
            showToast('Password changed! Please login again.', 'success');
            document.querySelector('.modal')?.remove();
            setTimeout(() => logout(), 2000);
        } else {
            showToast(res.error || 'Failed', 'error');
        }
    } catch (e) { showToast('Error changing password', 'error'); }
    hideButtonLoading(btn, orig);
}

// ============================================================
// CHART
// ============================================================
function renderChart(summary) {
    const canvas = document.getElementById('financialChart');
    if (!canvas) return;
    const savings = summary.savings || 0;
    const loans = summary.loansTaken || 0;
    const repaid = summary.repaid || 0;
    const net = savings - loans + repaid;

    document.getElementById('summaryStatAvailable').textContent = `KES ${savings.toLocaleString('en-KE')}`;
    document.getElementById('summaryStatOutstanding').textContent = `KES ${(summary.outstanding || 0).toLocaleString('en-KE')}`;
    document.getElementById('summaryStatInterest').textContent = `KES ${(summary.interestEarned || 0).toLocaleString('en-KE')}`;

    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const ctx = canvas.getContext('2d');
    const total = savings + loans + repaid;

    const centerTextPlugin = {
        id: 'centerText',
        afterDraw(chart) {
            const { ctx, chartArea } = chart;
            if (!chartArea) return;
            const cx = (chartArea.left + chartArea.right) / 2;
            const cy = (chartArea.top + chartArea.bottom) / 2;
            ctx.save();
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillStyle = '#7C8AA5';
            ctx.font = `600 ${window.innerWidth < 500 ? 9 : 11}px Inter, sans-serif`;
            ctx.fillText('NET BALANCE', cx, cy - 14);
            ctx.fillStyle = net >= 0 ? '#14213D' : '#1E3FC4';
            ctx.font = `700 ${window.innerWidth < 500 ? 16 : 20}px Inter, sans-serif`;
            ctx.fillText('KES ' + Math.round(net).toLocaleString('en-KE'), cx, cy + 8);
            ctx.restore();
        }
    };

    chartInstance = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Savings', 'Loans Taken', 'Repaid'],
            datasets: [{
                data: [savings, loans, repaid],
                backgroundColor: ['rgba(20, 33, 61, 0.85)', 'rgba(59, 111, 242, 0.9)', 'rgba(20, 33, 61, 0.3)'],
                borderColor: ['#FFFFFF', '#FFFFFF', '#FFFFFF'],
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        plugins: [centerTextPlugin],
        options: {
            responsive: true,
            maintainAspectRatio: true,
            cutout: '68%',
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { boxWidth: 12, boxHeight: 12, padding: 14, font: { size: window.innerWidth < 500 ? 10 : 12, weight: '600' }, color: '#7C8AA5' }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const value = context.parsed;
                            const pct = total > 0 ? ((value / total) * 100).toFixed(1) : '0';
                            return `${context.label}: KES ${value.toLocaleString('en-KE')} (${pct}%)`;
                        }
                    }
                }
            },
            animation: { duration: 1000, easing: 'easeOutQuart' }
        }
    });
}

// ============================================================
// EXPORT FUNCTIONS
// ============================================================
function exportToCSV() {
    if (!allRecords.length) { showToast('No transactions to export', 'error'); return; }
    const btn = document.getElementById('exportCsvBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Preparing...'; }
    try {
        const columns = ['Date', 'Member', 'Type', 'Amount (KES)', 'Message', 'Balance After'];
        const rows = [...allRecords].sort((a, b) => new Date(a.date) - new Date(b.date)).map(r => [
            r.date || '', r.member || '', r.type || '', r.amount || 0, r.message || '', r.balanceAfter || ''
        ]);
        const escapeCell = (val) => {
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`;
            return str;
        };
        const csvLines = [
            'Legacy Builders Group — Transaction Export',
            `Exported: ${new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' })}`,
            `Total records: ${rows.length}`, '',
            columns.map(escapeCell).join(','),
            ...rows.map(row => row.map(escapeCell).join(','))
        ];
        const csvContent = '\uFEFF' + csvLines.join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Legacy_Builders_Transactions_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
        showToast(`Exported ${rows.length} transactions`, 'success');
    } catch (e) { showToast('Error generating CSV', 'error'); }
    if (btn) { btn.disabled = false; btn.textContent = '📊 Download CSV / Excel'; }
}

function exportToPDF() {
    if (!allRecords.length) { showToast('No data to export', 'error'); return; }
    const exportBtn = document.getElementById('exportPdfBtn');
    const exportBtnOrig = exportBtn.innerHTML;
    showButtonLoading(exportBtn, 'Preparing PDF...');
    let savings = 0, loansTaken = 0, repaid = 0;
    allRecords.forEach(r => {
        if (r.type === 'Savings') savings += r.amount;
        else if (r.type === 'Loan Taken') loansTaken += r.amount;
        else if (r.type === 'Loan Repayment') repaid += r.amount;
    });
    const outstanding = Math.max(0, loansTaken - repaid);
    const net = savings - outstanding;

    const generator = document.getElementById('pdfGenerator');
    const preview = document.getElementById('pdfPreview');
    preview.innerHTML = `<div style="text-align:center;padding:30px;"><div style="width:40px;height:40px;border:3px solid #E7EBF5;border-top-color:#3B6FF2;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px;"></div><p style="color:#7C8AA5;">Generating PDF...</p></div>`;
    generator.classList.add('active');

    setTimeout(() => {
        const recentRecords = allRecords.slice(-10).reverse();
        const financialChartImg = chartInstance ? chartInstance.toBase64Image('image/png', 1) : null;
        const contentHtml = `
            <div id="pdfReportContent" style="max-width:800px;margin:0 auto;font-family:Arial,sans-serif;color:#14213D;font-size:12px;padding:10px;">
                <h1 style="text-align:center;border-bottom:2px solid #3B6FF2;padding-bottom:8px;">🏛️ Legacy Builders Group</h1>
                <h2 style="text-align:center;font-weight:400;margin-top:0;font-size:15px;">Financial Report</h2>
                <p style="text-align:center;color:#7C8AA5;font-size:10px;">${new Date().toLocaleDateString()}</p>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:6px;margin:10px 0;background:#F4F6FB;padding:10px;border-radius:8px;">
                    <div style="text-align:center;"><div style="font-size:8px;color:#7C8AA5;">Savings</div><div style="font-size:13px;font-weight:700;">KES ${savings.toLocaleString()}</div></div>
                    <div style="text-align:center;"><div style="font-size:8px;color:#7C8AA5;">Loans</div><div style="font-size:13px;font-weight:700;color:#1E3FC4;">KES ${loansTaken.toLocaleString()}</div></div>
                    <div style="text-align:center;"><div style="font-size:8px;color:#7C8AA5;">Repaid</div><div style="font-size:13px;font-weight:700;color:#1E3FC4;">KES ${repaid.toLocaleString()}</div></div>
                    <div style="text-align:center;"><div style="font-size:8px;color:#7C8AA5;">Net</div><div style="font-size:13px;font-weight:700;">KES ${net.toLocaleString()}</div></div>
                </div>
                ${financialChartImg ? `<div style="margin:10px 0;background:white;padding:10px;border-radius:8px;border:1px solid #E7EBF5;text-align:center;"><h3 style="margin:0 0 8px 0;font-size:12px;">📊 Financial Overview</h3><img src="${financialChartImg}" style="max-width:100%;height:auto;" /></div>` : ''}
                <h3 style="margin:10px 0 4px 0;font-size:12px;">📜 Recent Transactions</h3>
                <table style="width:100%;border-collapse:collapse;font-size:9px;margin-top:4px;">
                    <thead><tr style="background:#3B6FF2;color:white;"><th style="padding:3px 5px;text-align:left;">Date</th><th style="padding:3px 5px;text-align:left;">Member</th><th style="padding:3px 5px;text-align:left;">Type</th><th style="padding:3px 5px;text-align:right;">Amount</th></tr></thead>
                    <tbody>${recentRecords.map(r => `<tr style="border-bottom:1px solid #E7EBF5;"><td style="padding:3px 5px;">${new Date(r.date).toLocaleDateString('en-KE')}</td><td style="padding:3px 5px;font-weight:500;">${escapeHtml(r.member)}</td><td style="padding:3px 5px;">${r.type}</td><td style="padding:3px 5px;text-align:right;">${r.type === 'Loan Repayment' ? '+' : (r.type === 'Savings' ? '+' : '-')} KES ${(r.amount || 0).toLocaleString('en-KE')}</td></tr>`).join('')}</tbody>
                </table>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;padding:8px;background:#F4F6FB;border-radius:8px;">
                    <div style="text-align:center;"><div style="font-size:8px;color:#7C8AA5;">Total Members</div><div style="font-size:13px;font-weight:700;">${allMembers.length}</div></div>
                    <div style="text-align:center;"><div style="font-size:8px;color:#7C8AA5;">Total Transactions</div><div style="font-size:13px;font-weight:700;">${allRecords.length}</div></div>
                </div>
                <p style="text-align:center;color:#7C8AA5;font-size:9px;margin-top:12px;border-top:1px solid #E7EBF5;padding-top:10px;">Legacy Builders Group — Building Wealth Together</p>
                <button class="pdf-generate-btn" id="pdfGenerateBtn" style="background:#3B6FF2;color:#14213D;border:none;padding:10px 20px;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;width:100%;margin-top:12px;">📥 Download PDF</button>
                <button class="pdf-close-btn" onclick="document.getElementById('pdfGenerator').classList.remove('active')" style="position:absolute;top:8px;right:16px;background:none;border:none;font-size:20px;cursor:pointer;color:#7C8AA5;width:auto;">✕</button>
            </div>
        `;
        preview.innerHTML = contentHtml;
        document.getElementById('pdfGenerateBtn').addEventListener('click', function() {
            const btn = this;
            btn.disabled = true; btn.innerHTML = '⏳ Generating...';
            const reportSource = document.getElementById('pdfReportContent') || preview;
            const reportClone = reportSource.cloneNode(true);
            reportClone.querySelectorAll('.pdf-generate-btn, .pdf-close-btn').forEach(b => b.remove());
            const captureHost = document.createElement('div');
            captureHost.style.position = 'fixed';
            captureHost.style.top = '0';
            captureHost.style.left = '-9999px';
            captureHost.style.width = '800px';
            captureHost.style.background = '#ffffff';
            captureHost.appendChild(reportClone);
            document.body.appendChild(captureHost);
            const opt = {
                margin: 8,
                filename: `Legacy_Builders_Report_${new Date().toISOString().split('T')[0]}.pdf`,
                image: { type: 'jpeg', quality: 0.95 },
                html2canvas: { scale: 2, useCORS: true, logging: false, letterRendering: true, backgroundColor: '#ffffff' },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
                pagebreak: { mode: ['css', 'legacy'] }
            };
            html2pdf().set(opt).from(reportClone).save().then(() => {
                captureHost.remove();
                btn.disabled = false; btn.innerHTML = '📥 Download PDF';
                document.getElementById('pdfGenerator').classList.remove('active');
                showToast('PDF downloaded!', 'success');
            }).catch((err) => {
                captureHost.remove();
                btn.disabled = false; btn.innerHTML = '📥 Download PDF';
                showToast('Error generating PDF', 'error');
            });
        });
        hideButtonLoading(exportBtn, exportBtnOrig);
    }, 300);
}

// ============================================================
// PUSH NOTIFICATIONS
// ============================================================
function isNotificationSupported() { return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window; }
function getNotificationPermission() { if (!isNotificationSupported()) return 'unsupported'; return Notification.permission; }

function checkAndShowNotificationPrompt() {
    if (!isNotificationSupported()) return;
    const permission = getNotificationPermission();
    if (permission === 'default') {
        const prompt = document.getElementById('notificationPrompt');
        if (prompt) { prompt.classList.add('active'); setTimeout(() => prompt.classList.remove('active'), 10000); }
    } else if (permission === 'granted') { registerServiceWorker(); }
}

function dismissNotificationPrompt() { document.getElementById('notificationPrompt').classList.remove('active'); }

async function requestNotificationPermission() {
    if (!isNotificationSupported()) { showToast('Notifications not supported', 'error'); return; }
    try {
        const permission = await Notification.requestPermission();
        if (permission === 'granted') {
            showToast('✅ Notifications enabled!', 'success');
            document.getElementById('notificationPrompt').classList.remove('active');
            await registerServiceWorker();
            await subscribeToPush();
        } else {
            showToast('❌ Notification permission denied', 'error');
        }
    } catch (e) { showToast('Error enabling notifications', 'error'); }
}

async function registerServiceWorker() {
    try {
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.register('/service-worker.js');
            console.log('Service Worker registered');
            serviceWorkerRegistered = true;
            return registration;
        }
    } catch (e) { console.error('Service Worker registration failed:', e); }
    return null;
}

function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
}

async function subscribeToPush() {
    try {
        if (!serviceWorkerRegistered) await registerServiceWorker();
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) {
            subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
            });
        }
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'savePushSubscription', email: currentUserEmail, subscription: subscription.toJSON() })
        });
        const res = await response.json();
        if (res.success) {
            pushSubscription = subscription;
            showToast('🔔 Push notifications enabled!', 'success');
        } else {
            showToast('Failed to save subscription', 'error');
        }
        return subscription;
    } catch (e) {
        showToast('Push subscription failed', 'error');
        return null;
    }
}

// ============================================================
// TAB ACTIVATION
// ============================================================
const PANEL_TITLES = {
    summary: '📊 Summary',
    loans: '💰 Loans',
    meetings: '📝 Meetings',
    pending: '⏳ Pending Approvals',
    about: '👥 About Us',
    developer: '🛠️ Developer Portal'
};

function ensureFullscreenBar(panel, tabId) {
    if (!panel.classList.contains('fullscreen-panel')) return;
    if (panel.querySelector('.fullscreen-panel-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'fullscreen-panel-bar';
    bar.innerHTML = `<button class="fullscreen-panel-back" onclick="activateTab('transactions')">←</button><h2>${PANEL_TITLES[tabId] || ''}</h2>`;
    panel.insertBefore(bar, panel.firstChild);
}

function activateTab(tabId) {
    document.querySelectorAll('.tab, .sidebar-link').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active-panel'));
    const btn = document.querySelector(`.tab[data-panel="${tabId}"]`);
    if (btn) btn.classList.add('active');
    const sidebarBtn = document.querySelector(`.sidebar-link[data-panel="${tabId}"]`);
    if (sidebarBtn) sidebarBtn.classList.add('active');
    const panel = document.getElementById(tabId + 'Panel');
    if (panel) {
        ensureFullscreenBar(panel, tabId);
        panel.classList.remove('panel-enter');
        void panel.offsetWidth;
        panel.classList.add('active-panel', 'panel-enter');
    }
    const appContainer = document.getElementById('appContainer');
    if (appContainer) appContainer.classList.toggle('dashboard-active', tabId === 'transactions');
    localStorage.setItem('legacy_active_tab', tabId);
    currentTab = tabId;
    if (tabId !== 'transactions') loadAllData(false, true);
}

// ============================================================
// MEMORIES CAROUSEL
// ============================================================
const GROUP_MEMORY_PHOTOS = [];
let memoriesIndex = 0, memoriesInterval = null;

function initMemoriesCarousel() {
    const card = document.getElementById('memoriesCard');
    const track = document.getElementById('memoriesCarousel');
    const dotsWrap = document.getElementById('memoriesDots');
    if (!card || !track || !dotsWrap) return;
    if (!GROUP_MEMORY_PHOTOS.length) {
        card.style.display = 'none';
        if (memoriesInterval) { clearInterval(memoriesInterval); memoriesInterval = null; }
        return;
    }
    card.style.display = 'block';
    track.innerHTML = GROUP_MEMORY_PHOTOS.map(p => `<img src="${p.url}" alt="${escapeHtml(p.caption || 'Group memory')}" loading="lazy">`).join('');
    dotsWrap.innerHTML = GROUP_MEMORY_PHOTOS.map((_, i) => `<span class="memories-dot${i === 0 ? ' active' : ''}"></span>`).join('');
    memoriesIndex = 0; updateMemoriesPosition();
    if (memoriesInterval) clearInterval(memoriesInterval);
    if (GROUP_MEMORY_PHOTOS.length > 1 && !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
        memoriesInterval = setInterval(() => { memoriesIndex = (memoriesIndex + 1) % GROUP_MEMORY_PHOTOS.length; updateMemoriesPosition(); }, 4000);
    }
}

function updateMemoriesPosition() {
    const track = document.getElementById('memoriesCarousel');
    if (track) track.style.transform = `translateX(-${memoriesIndex * 100}%)`;
    document.querySelectorAll('.memories-dot').forEach((dot, i) => dot.classList.toggle('active', i === memoriesIndex));
}

// ============================================================
// LOGOUT
// ============================================================
function logout(event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    if (countdownInterval) clearInterval(countdownInterval);
    localStorage.removeItem('legacy_current_user');
    localStorage.removeItem('legacy_current_email');
    localStorage.removeItem('legacy_current_role');
    localStorage.removeItem('legacy_active_tab');
    if (refreshInterval) clearInterval(refreshInterval);
    currentUser = null; currentUserEmail = null; currentUserRole = null;
    allRecords = []; allMembers = []; pendingLoans = []; completedLoans = []; pendingTransactions = []; isLoading = false;
    pushSubscription = null; serviceWorkerRegistered = false;
    document.getElementById('appContainer').classList.remove('active');
    document.getElementById('tabBar').style.display = 'none';
    document.getElementById('sidebarNav')?.classList.remove('active');
    document.getElementById('loginOverlay').classList.add('active');
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginError').style.display = 'none';
    showToast('Logged out', 'success');
    document.getElementById('splashScreen').style.display = 'flex';
    document.getElementById('splashScreen').classList.remove('hidden');
    setTimeout(hideSplashScreen, 800);
}

// ============================================================
// DOM READY
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    const splash = document.getElementById('splashScreen');
    const hasPersistentSession = checkPersistentLogin();
    splash.style.display = 'flex';
    splash.classList.remove('hidden');

    if (hasPersistentSession) {
        const profileRes = await callAPI('getProfileImage', { email: currentUserEmail });
        if (profileRes.success && profileRes.image) {
            userProfileImage = profileRes.image;
            localStorage.setItem('legacy_profile_image', userProfileImage);
        }
        document.getElementById('loginOverlay').classList.remove('active');
        document.getElementById('appContainer').classList.add('active');
        document.getElementById('tabBar').style.display = 'flex';
        document.getElementById('sidebarNav')?.classList.add('active');
        document.getElementById('loggedInUser').innerText = currentUser;
        document.getElementById('date').value = new Date().toISOString().split('T')[0];
        hideSplashScreen();
        updateHeaderAvatar();
        showHideDeveloperPortal();
        showHidePendingTab();
        showBalanceLoading(true);
        updateDashboardGreeting();
        initMemoriesCarousel();
        await loadAllData();
        await delay(150);
        await Promise.all([
            loadMeetingMinutes(),
            delay(150).then(() => loadScheduledMeeting()),
            delay(300).then(() => loadMembersList())
        ]);
        document.querySelectorAll('.tab, .sidebar-link').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active-panel'));
        const activeTabBtn2 = document.querySelector(`.tab[data-panel="${currentTab}"]`);
        if (activeTabBtn2) activeTabBtn2.classList.add('active');
        const activeSidebarBtn2 = document.querySelector(`.sidebar-link[data-panel="${currentTab}"]`);
        if (activeSidebarBtn2) activeSidebarBtn2.classList.add('active');
        const activePanel2 = document.getElementById(currentTab + 'Panel');
        if (activePanel2) {
            ensureFullscreenBar(activePanel2, currentTab);
            activePanel2.classList.add('active-panel', 'panel-enter');
        }
        const appContainerEl2 = document.getElementById('appContainer');
        if (appContainerEl2) appContainerEl2.classList.toggle('dashboard-active', currentTab === 'transactions');
        localStorage.setItem('legacy_active_tab', currentTab);
        showBalanceLoading(false);
        setTimeout(() => checkAndShowNotificationPrompt(), 3000);
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(() => {
            if (currentUser) {
                loadAllData(true);
                loadScheduledMeeting();
                loadMembersList();
            }
        }, 30000);
    } else {
        hideSplashScreen();
        document.getElementById('loginOverlay').classList.add('active');
    }

    document.getElementById('addBtn').onclick = addRecord;
    document.getElementById('exportPdfBtn').onclick = exportToPDF;
    document.getElementById('loginPassword')?.addEventListener('keypress', (e) => { if (e.key === 'Enter') loginWithPassword(); });
    document.querySelectorAll('.tab, .sidebar-link').forEach(tab => { tab.onclick = () => activateTab(tab.dataset.panel); });
});

// ============================================================
// GLOBAL EXPOSURE
// ============================================================
window.toggleReadMore = toggleReadMore;
window.openChangePasswordModal = openChangePasswordModal;
window.changePassword = changePassword;
window.logout = logout;
window.cancelLoanRequest = cancelLoanRequest;
window.deleteMeeting = deleteMeeting;
window.scheduleNextMeeting = scheduleNextMeeting;
window.cancelScheduledMeeting = cancelScheduledMeeting;
window.sendAnnouncement = sendAnnouncement;
window.loginWithPassword = loginWithPassword;
window.verifyOtpAndLogin = verifyOtpAndLogin;
window.resendOtpCode = resendOtpCode;
window.backToLoginFromOtp = backToLoginFromOtp;
window.registerUser = registerUser;
window.showRegisterForm = showRegisterForm;
window.showLoginForm = showLoginForm;
window.showForgotPasswordForm = showForgotPasswordForm;
window.requestPasswordReset = requestPasswordReset;
window.openProfileModal = openProfileModal;
window.handleProfileImageUpload = handleProfileImageUpload;
window.viewMemberProfile = viewMemberProfile;
window.exportToPDF = exportToPDF;
window.requestNotificationPermission = requestNotificationPermission;
window.dismissNotificationPrompt = dismissNotificationPrompt;
window.checkAndShowNotificationPrompt = checkAndShowNotificationPrompt;
window.loadDeveloperPortal = loadDeveloperPortal;
window.loadAllUsersFull = loadAllUsersFull;
window.updateUserRole = updateUserRole;
window.deleteUser = deleteUser;
window.approveRegistration = approveRegistration;
window.rejectRegistration = rejectRegistration;
window.refreshAllData = refreshAllData;
window.exportSystemData = exportSystemData;
window.clearSystemCache = clearSystemCache;
window.isDeveloper = isDeveloper;
window.approveTransaction = approveTransaction;
window.rejectTransaction = rejectTransaction;
window.approveLoan = approveLoan;
window.rejectLoan = rejectLoan;
window.submitLoanDueDate = submitLoanDueDate;
window.addRecord = addRecord;
window.openAddTransactionModal = openAddTransactionModal;
window.closeAddTransactionModal = closeAddTransactionModal;
window.openHistoryModal = openHistoryModal;
window.openViewMinutesModal = openViewMinutesModal;
window.openScheduleMeetingModal = openScheduleMeetingModal;
window.openSendAnnouncementModal = openSendAnnouncementModal;
window.openAuditLogModal = openAuditLogModal;
window.exportToCSV = exportToCSV;
window.toggleWalletScopeMenu = toggleWalletScopeMenu;
window.setWalletScope = setWalletScope;
window.submitTransactionEdit = submitTransactionEdit;
window.openEditTransactionModal = openEditTransactionModal;
window.rejectTransactionEdit = rejectTransactionEdit;