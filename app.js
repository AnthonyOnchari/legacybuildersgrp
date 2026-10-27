// ============================================================
// CONFIGURATION
// ============================================================
const TREASURER_NAME = "Mrs. Kithinji";
const VAPID_PUBLIC_KEY = 'BB4N47xyKjLw-K29lXDolpcht45pVZcqV4m-Iw-8tJBk8g21yE66KVJmxbNOIDEIRBun-JDACI0lK4MRIvVwYH0';
const DEVELOPMENT_PREVIEW_PROFILE_IMAGE = 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=800&q=80';
const DEVELOPMENT_PREVIEW_ENABLED = ['localhost', '127.0.0.1'].includes(window.location.hostname)
    && new URLSearchParams(window.location.search).get('preview') === '1';

let allRecords = [], allMembers = [], allMembersData = [], pendingLoans = [], completedLoans = [], loanRequests = [];
let pendingTransactions = [], pendingEditsMap = {}, activeLoans = [], loansAwaitingDueDate = [];
let currentUser = null, currentUserDisplayName = null, currentUserEmail = null, currentUserRole = null;
let currentTab = localStorage.getItem('legacy_active_tab') || 'transactions';
let countdownInterval = null, refreshInterval = null;
let userProfileImage = null;
let currentUserPhone = '', currentUserPhoneCountry = '', currentUserPhoneDialCode = '';
let currentUserPhoneVerifiedAt = '', currentUserPhoneVerifiedBy = '';
let isLoading = false, chartInstance = null;
let dashboardLoaded = false;
let appBackNavigationInitialized = false;
let unreadGroupMessages = 0;
let unreadMeetingUpdates = false;
const memberPhotoCache = {};
let serviceWorkerRegistered = false, pushSubscription = null;
const countUpFrames = new WeakMap();
let memberRollContainer = null, memberRollObserver = null, memberRollAnimationFrame = 0;
const memberRollReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// ============================================================
// UTILITY FUNCTIONS
// ============================================================
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getLocalDateInputValue(date = new Date()) {
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().split('T')[0];
}

function updateLoanRequestedDueDateMinimum() {
    const dueDateInput = document.getElementById('loanRequestedDueDate');
    const requestDateInput = document.getElementById('date');
    if (!dueDateInput || !requestDateInput?.value) return;
    const minimumDate = new Date(`${requestDateInput.value}T00:00:00`);
    if (Number.isNaN(minimumDate.getTime())) return;
    minimumDate.setDate(minimumDate.getDate() + 1);
    dueDateInput.min = getLocalDateInputValue(minimumDate);
}

function isTreasurer() { return currentUser === TREASURER_NAME; }

function isDeveloper() { return currentUserRole === 'developer'; }

function hasAdminPortalAccess() { return currentUserRole === 'admin' || isDeveloper(); }

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

function unreadStorageKey(kind) {
    const version = kind === 'group_messages' ? '_v2' : '';
    return `legacy_${kind}_seen${version}_${String(currentUserEmail || currentUser || 'member').toLowerCase()}`;
}

function updateUnreadIndicators() {
    const sidebarLink = document.querySelector('.sidebar-link[data-panel="meetings"]');
    if (sidebarLink) {
        const labels = sidebarLink.querySelectorAll('span');
        if (labels[1]) labels[1].textContent = 'Connect';
        if (!document.getElementById('connectSidebarBadge')) {
            sidebarLink.insertAdjacentHTML('beforeend', '<span id="connectSidebarBadge" class="nav-unread-badge" hidden></span>');
        }
    }
    const messageBadge = document.getElementById('connectTabBadge');
    const sidebarBadge = document.getElementById('connectSidebarBadge');
    const heroBadge = document.getElementById('heroChatBadge');
    [messageBadge, sidebarBadge, heroBadge].forEach(el => {
        if (!el) return;
        const hasUnread = unreadGroupMessages > 0;
        el.textContent = hasUnread ? (unreadGroupMessages > 99 ? '99+' : String(unreadGroupMessages)) : '';
        el.hidden = !hasUnread;
        el.style.display = hasUnread ? '' : 'none';
    });
}

function scrollGroupMessagesToBottom(behavior = 'auto') {
    const container = document.getElementById('groupMessages');
    if (!container) return;
    requestAnimationFrame(() => {
        container.scrollTo({ top: container.scrollHeight, behavior });
    });
}

function syncChatViewport() {
    const viewport = window.visualViewport;
    const keyboardOffset = viewport ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    document.documentElement.style.setProperty('--chat-keyboard-offset', `${keyboardOffset}px`);
    if (document.getElementById('groupChatModal')?.style.display !== 'none') scrollGroupMessagesToBottom();
}

function markGroupMessagesRead() {
    localStorage.setItem(unreadStorageKey('group_messages'), new Date().toISOString());
    unreadGroupMessages = 0;
    updateUnreadIndicators();
}

function markMeetingUpdatesRead() {
    localStorage.setItem(unreadStorageKey('meeting_updates'), new Date().toISOString());
    unreadMeetingUpdates = false;
    updateUnreadIndicators();
}

// ============================================================
// API CALL
// ============================================================
async function callAPI(action, data = {}, _retryCount = 0) {
    if (DEVELOPMENT_PREVIEW_ENABLED) {
        return { success: false, error: 'API actions are disabled in the local sample-data preview.' };
    }
    try {
        const firebaseUser = window.firebaseAuth && window.firebaseAuth.currentUser;
        if (!firebaseUser) throw new Error('Please sign in with Google first.');
        const idToken = await firebaseUser.getIdToken(_retryCount > 0);
        const response = await fetch(window.FIREBASE_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${idToken}`
            },
            body: JSON.stringify({ action, ...data })
        });
        const responseBody = await response.text();
        let result;
        try {
            result = JSON.parse(responseBody);
        } catch {
            throw new Error(`The API returned an invalid response (HTTP ${response.status}). Please check the server deployment.`);
        }
        if (!response.ok || !result.success) {
            throw new Error(result.error || `Firebase request failed (${response.status})`);
        }
        return result;
    } catch (e) {
        if (e instanceof TypeError && _retryCount < 2) {
            await delay(500 * (2 ** _retryCount));
            return callAPI(action, data, _retryCount + 1);
        }
        console.error('API Error:', e);
        return { success: false, error: e.message };
    }
}

// ============================================================
// SPLASH SCREEN
// ============================================================
// ============================================================
// LOGIN FUNCTIONS
// ============================================================
let pendingLoginToken = null, pendingLoginEmail = null, otpResendTimer = null;
let authTransitionTimer = null;

function animateAuthTransition() {
    const loginBox = document.querySelector('.login-box');
    if (authTransitionTimer) clearTimeout(authTransitionTimer);
    loginBox.classList.remove('auth-transition');
    void loginBox.offsetWidth;
    loginBox.classList.add('auth-transition');
    authTransitionTimer = setTimeout(() => {
        loginBox.classList.remove('auth-transition');
        authTransitionTimer = null;
    }, 420);
}

function initializeAuthVideoLoop() {
    const videos = Array.from(document.querySelectorAll('.login-photo'));
    if (videos.length < 2) return;

    let activeVideo = videos.find(video => video.classList.contains('is-visible')) || videos[0];
    let nextVideo = videos.find(video => video !== activeVideo);
    let isTransitioning = false;
    let crossfadeUnavailable = false;
    const crossfadeDurationMs = 1200;
    const crossfadeLeadTimeSeconds = 1.6;

    nextVideo.load();
    videos.forEach(video => {
        video.addEventListener('timeupdate', async () => {
            if (video !== activeVideo || isTransitioning || crossfadeUnavailable || !Number.isFinite(video.duration)) return;
            if (video.duration - video.currentTime > crossfadeLeadTimeSeconds) return;

            isTransitioning = true;
            nextVideo.currentTime = 0;
            try {
                await nextVideo.play();
            } catch (error) {
                console.warn('Auth video crossfade could not start; using the native video loop.', error);
                crossfadeUnavailable = true;
                isTransitioning = false;
                return;
            }

            const outgoingVideo = activeVideo;
            activeVideo = nextVideo;
            nextVideo = outgoingVideo;
            activeVideo.classList.add('is-visible');
            outgoingVideo.classList.remove('is-visible');

            setTimeout(() => {
                outgoingVideo.pause();
                outgoingVideo.currentTime = 0;
                isTransitioning = false;
            }, crossfadeDurationMs);
        });
    });
}

function checkPersistentLogin() {
    const user = window.firebaseAuth && window.firebaseAuth.currentUser;
    if (!user) return false;
    currentUser = user.displayName || user.email.split('@')[0];
    currentUserEmail = user.email;
    return true;
}

function showLoginForm() {
    document.getElementById('loginTitle').textContent = 'Log in to your account';
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('forgotPasswordForm').style.display = 'none';
    document.getElementById('otpForm').style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('registerError').style.display = 'none';
    document.getElementById('resetError').style.display = 'none';
    document.getElementById('resetSuccess').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = 'Your group, your progress, all in one place.';
    document.querySelector('.login-box').classList.remove('is-registering');
    animateAuthTransition();
}

function showRegisterForm() {
    document.getElementById('loginTitle').textContent = 'Set up your account';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'block';
    document.getElementById('forgotPasswordForm').style.display = 'none';
    document.getElementById('otpForm').style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('registerError').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = 'Request approval to join the group.';
    document.querySelector('.login-box').classList.add('is-registering');
    animateAuthTransition();
}

function showForgotPasswordForm() {
    document.getElementById('loginTitle').textContent = 'Reset your password';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('forgotPasswordForm').style.display = 'block';
    document.getElementById('otpForm').style.display = 'none';
    document.getElementById('loginError').style.display = 'none';
    document.getElementById('resetError').style.display = 'none';
    document.getElementById('resetSuccess').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = "We'll help you get back in";
    document.querySelector('.login-box').classList.remove('is-registering');
    animateAuthTransition();
}

function showOtpScreen(emailHint) {
    document.getElementById('loginTitle').textContent = 'Verify your email';
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('registerForm').style.display = 'none';
    document.getElementById('forgotPasswordForm').style.display = 'none';
    document.getElementById('otpForm').style.display = 'block';
    document.getElementById('otpEmailHint').textContent = emailHint || pendingLoginEmail || '';
    document.getElementById('otpError').style.display = 'none';
    document.getElementById('loginSubtitle').textContent = 'Enter the code we emailed you';
    document.querySelector('.login-box').classList.remove('is-registering');
    animateAuthTransition();
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

function setGoogleSignInLoading(isLoading) {
    const control = document.getElementById('googleSignInControl');
    if (!control) return;
    control.classList.toggle('is-loading', isLoading);
    control.setAttribute('aria-busy', String(isLoading));
}

function initializeGoogleSignIn() {
    const button = document.getElementById('googleSignInButton');
    if (!button) return;
    if (!window.GOOGLE_OAUTH_CLIENT_ID || !window.google?.accounts?.id) {
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = 'Google sign-in could not load. Check your connection and reload.';
        errorEl.style.display = 'block';
        return;
    }

    const isMobileBrowser = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isMobileBrowser && !('IdentityCredential' in window)) {
        button.parentElement.hidden = true;
        const errorEl = document.getElementById('loginError');
        errorEl.textContent = "Google's in-page account chooser requires an updated Chrome browser on this device.";
        errorEl.style.display = 'block';
        return;
    }

    window.google.accounts.id.initialize({
        client_id: window.GOOGLE_OAUTH_CLIENT_ID,
        callback: loginWithGoogle,
        auto_select: false,
        use_fedcm_for_button: true,
        button_auto_select: false
    });
    window.google.accounts.id.renderButton(button, {
        type: 'standard',
        theme: 'outline',
        size: 'large',
        text: 'continue_with',
        shape: 'rectangular',
        width: Math.min(390, Math.floor(button.parentElement.clientWidth))
    });
}

async function loginWithGoogle(response) {
    const errorEl = document.getElementById('loginError');
    errorEl.style.display = 'none';
    setGoogleSignInLoading(true);
    try {
        if (!response?.credential) throw new Error('Google did not return an account credential. Please try again.');
        const firebaseCredential = firebase.auth.GoogleAuthProvider.credential(response.credential);
        const credential = await window.firebaseAuth.signInWithCredential(firebaseCredential);
        const res = await callAPI('bootstrapProfile');
        if (!res.success) {
            errorEl.textContent = res.error || 'Could not verify your account. Please try again.';
            errorEl.style.display = 'block';
            return;
        }
        if (res.status !== 'approved') {
            await window.firebaseAuth.signOut();
            errorEl.textContent = res.status === 'pending'
                ? 'Your registration is awaiting approval. Please contact the treasurer.'
                : 'This account is not approved. Please contact the treasurer.';
            errorEl.style.display = 'block';
            return;
        }
        currentUserRole = res.role || 'member';
        await completeLogin(res.name || credential.user.displayName, credential.user.email, res);
    } catch (e) {
        if (e.code === 'auth/popup-blocked') {
            errorEl.textContent = 'Allow pop-ups for this site, then try Google sign-in again.';
        } else if (e.code === 'auth/popup-closed-by-user') {
            errorEl.textContent = 'Google sign-in was closed before you selected an account.';
        } else {
            errorEl.textContent = e.message || 'Google sign-in failed.';
        }
        errorEl.style.display = 'block';
    } finally {
        setGoogleSignInLoading(false);
    }
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
function activateCurrentTab() {
    initializeAppBackNavigation();
    if (currentTab === 'groupChat') currentTab = 'meetings';
    if (currentTab === 'about') currentTab = 'transactions';
    // Developer tools are opened from the protected header button, never as the Home tab.
    if (currentTab === 'developer') currentTab = 'transactions';
    if (currentTab === 'pending' && !hasAdminPortalAccess()) {
        currentTab = 'transactions';
    }
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
    if (currentTab === 'pending') {
        loadAdminMemberProfiles('adminPhoneProfiles');
        loadAllUsersFull('adminAllUsersList');
    }
    if (currentTab === 'developer') loadAdminMemberProfiles('developerPhoneProfiles');
    if (currentTab === 'loans') loadLoansDashboard();
    if (currentTab === 'meetings') loadGroupMessages();
}

async function completeLogin(name, email, profile = {}) {
    if (!name || name.trim() === '') {
        name = email ? email.split('@')[0] : 'Member';
        name = name.charAt(0).toUpperCase() + name.slice(1);
    }
    currentUser = name;
    currentUserDisplayName = profile.displayName || name;
    currentUserEmail = email;
    currentUserRole = profile.role || currentUserRole || 'member';
    currentUserPhone = profile.phone || '';
    currentUserPhoneCountry = profile.phoneCountry || '';
    currentUserPhoneDialCode = profile.phoneDialCode || '';
    currentUserPhoneVerifiedAt = profile.phoneVerifiedAt || '';
    currentUserPhoneVerifiedBy = profile.phoneVerifiedBy || '';
    userProfileImage = null;
    localStorage.setItem('legacy_current_user', currentUser);
    localStorage.setItem('legacy_current_email', email);
    localStorage.setItem('legacy_current_role', currentUserRole || 'member');

    document.getElementById('loginOverlay').classList.remove('active');
    document.getElementById('appContainer').classList.add('active');
    document.getElementById('tabBar').style.display = 'flex';
    document.getElementById('sidebarNav').classList.add('active');
    document.getElementById('loggedInUser').innerText = currentUserDisplayName;
    document.getElementById('date').value = getLocalDateInputValue();

    updateHeaderAvatar();
    updateDashboardGreeting();
    showHideDeveloperPortal();
    showHidePendingTab();

    showBalanceLoading(true);
    activateCurrentTab();
    const profileImageLoad = callAPI('getProfileImage', { email }).then(profileRes => {
        if (profileRes.success && profileRes.image) {
            userProfileImage = profileRes.image;
            localStorage.setItem(`legacy_profile_image_${email.toLowerCase()}`, userProfileImage);
            updateHeaderAvatar();
        }
    });
    await Promise.all([
        loadAllData(),
        loadGroupMemories(),
        profileImageLoad,
        loadMeetingMinutes(),
        loadScheduledMeeting(),
        loadMembersList()
    ]);

    showBalanceLoading(false);
    showToast(`Welcome ${currentUserDisplayName}!`, 'success');

    setTimeout(() => {
        checkAndShowNotificationPrompt();
        registerServiceWorker();
    }, 3000);

    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setInterval(() => {
        if (currentUser) {
            loadAllData(true);
            loadGroupMessages();
            loadGroupMemories();
            loadScheduledMeeting();
            loadMembersList();
        }
    }, 30000);
}

// ============================================================
// SHOW/HIDE DEVELOPER PORTAL
// ============================================================
function showHideDeveloperPortal() {
    const isDev = isDeveloper();
    const devTab = document.getElementById('developerTab');
    const devSidebar = document.getElementById('developerSidebarLink');
    const portalButton = document.getElementById('adminPortalButton');
    const portalLabel = document.getElementById('adminPortalButtonLabel');
    if (portalButton) {
        portalButton.style.display = hasAdminPortalAccess() ? 'inline-flex' : 'none';
        portalButton.setAttribute('aria-haspopup', isDev ? 'dialog' : 'false');
    }
    if (portalLabel) portalLabel.textContent = isDev ? 'Developer Portal' : 'Admin Portal';

    // Keep developer data out of Home and the regular navigation. It is available
    // through the protected Developer Portal button only.
    if (devTab) devTab.style.display = 'none';
    if (devSidebar) devSidebar.style.display = 'none';
}

let developerPortalModal = null;

function openDeveloperPortalModal() {
    if (!isDeveloper()) {
        showToast('Developer portal access is restricted.', 'error');
        return;
    }
    if (developerPortalModal) {
        developerPortalModal.dialog?.querySelector('.developer-modal-close')?.focus();
        return;
    }

    const panel = document.getElementById('developerPanel');
    if (!panel) return;
    const originalParent = panel.parentNode;
    const originalNextSibling = panel.nextSibling;
    const placeholder = document.createComment('developer-portal-placeholder');
    originalParent?.insertBefore(placeholder, panel);

    const overlay = document.createElement('div');
    overlay.className = 'developer-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'developerModalTitle');
    const dialog = document.createElement('section');
    dialog.className = 'developer-modal-dialog';
    dialog.innerHTML = `
        <div class="developer-modal-header">
            <div><span class="developer-portal-kicker">PRIVATE ACCESS</span><h2 id="developerModalTitle">Developer portal</h2></div>
            <button type="button" class="developer-modal-close" aria-label="Close developer portal">Close</button>
        </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    panel.classList.remove('fullscreen-panel', 'active-panel', 'panel-enter');
    panel.classList.add('developer-portal-modal-content', 'active-panel');
    dialog.appendChild(panel);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    developerPortalModal = { overlay, dialog, panel, placeholder, originalParent, originalNextSibling, previousOverflow };

    const close = () => closeDeveloperPortalModal();
    dialog.querySelector('.developer-modal-close').addEventListener('click', close);
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay._onKeyDown = event => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', overlay._onKeyDown);
    if (typeof loadAdminMemberProfiles === 'function') loadAdminMemberProfiles('developerPhoneProfiles');
    if (typeof loadDeveloperPortal === 'function') loadDeveloperPortal();
    requestAnimationFrame(() => dialog.querySelector('.developer-modal-close')?.focus());
}

function closeDeveloperPortalModal() {
    if (!developerPortalModal) return;
    const state = developerPortalModal;
    document.removeEventListener('keydown', state.overlay._onKeyDown);
    state.panel.classList.remove('developer-portal-modal-content', 'active-panel', 'panel-enter');
    state.panel.classList.add('fullscreen-panel');
    if (state.placeholder.parentNode) {
        state.placeholder.parentNode.replaceChild(state.panel, state.placeholder);
    } else if (state.originalParent) {
        state.originalParent.insertBefore(state.panel, state.originalNextSibling);
    }
    state.overlay.remove();
    document.body.style.overflow = state.previousOverflow;
    developerPortalModal = null;
    document.getElementById('adminPortalButton')?.focus();
}

function showHidePendingTab() {
    const show = hasAdminPortalAccess();
    document.getElementById('pendingTab').style.display = show ? 'flex' : 'none';
    document.getElementById('pendingSidebarLink').style.display = show ? 'flex' : 'none';
    if (show) loadPendingRegistrations();
}

function openAdminPortal() {
    if (!hasAdminPortalAccess()) {
        showToast('The admin portal is available to approved administrators only.', 'error');
        return;
    }
    if (isDeveloper()) {
        openDeveloperPortalModal();
        return;
    }
    activateTab('pending');
}

// ============================================================
// REGISTRATION
// ============================================================
async function submitJoinRequest(name, email) {
    let response;
    try {
        response = await fetch(window.FIREBASE_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'submitJoinRequest', name, email })
        });
    } catch (error) {
        throw new Error(`Could not send your request: ${error.message}`);
    }
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error(`The server returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok || !result.success) {
        throw new Error(result.error || `Request failed (HTTP ${response.status}).`);
    }
    return result;
}

async function registerUser(button) {
    const email = document.getElementById('registerEmail').value.trim();
    const name = document.getElementById('registerName').value.trim();
    const errorEl = document.getElementById('registerError');
    errorEl.style.display = 'none';
    if (!email || !name) {
        errorEl.textContent = 'Please fill all fields';
        errorEl.style.display = 'block';
        return;
    }
    if (!email.includes('@')) {
        errorEl.textContent = 'Please enter a valid email address';
        errorEl.style.display = 'block';
        return;
    }
    const btn = button || document.querySelector('#registerForm .login-btn');
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Sending request...');
    try {
        await submitJoinRequest(name, email);
        showToast('Your request was sent to the group for review.', 'success');
        showLoginForm();
        document.getElementById('registerEmail').value = '';
        document.getElementById('registerName').value = '';
    } catch (e) {
        errorEl.textContent = e.message || 'Could not send your request.';
        errorEl.style.display = 'block';
    } finally {
        hideButtonLoading(btn, orig);
    }
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
            successEl.textContent = 'Password reset successfully! Check your email.';
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
    const walletImageEl = document.getElementById('walletProfileImage');
    const walletPhoneEl = document.getElementById('walletCardNumber');
    const walletCardholderNameEl = document.getElementById('walletCardholderName');
    const profileImage = getProfileImage();
    document.querySelectorAll('.fullscreen-panel-avatar').forEach(avatar => {
        avatar.replaceChildren();
        if (profileImage) {
            const image = document.createElement('img');
            image.src = profileImage;
            image.alt = '';
            avatar.appendChild(image);
        } else {
            avatar.textContent = getInitials(currentUserDisplayName || currentUser);
        }
    });
    document.querySelectorAll('.fullscreen-panel-user-name').forEach(name => {
        name.textContent = currentUserDisplayName || currentUser || '';
    });
    if (walletImageEl) {
        if (profileImage) {
            walletImageEl.crossOrigin = 'anonymous';
            walletImageEl.src = profileImage;
            walletImageEl.hidden = false;
        } else {
            walletImageEl.removeAttribute('src');
            walletImageEl.hidden = true;
        }
    }
    if (walletPhoneEl) {
        const phone = currentUserPhone.trim();
        const dialCode = currentUserPhoneDialCode
            || PHONE_COUNTRIES.find(country => country.code === currentUserPhoneCountry)?.dialCode
            || '';
        const dialDigits = dialCode.replace(/\D/g, '');
        let numberDigits = phone.replace(/\D/g, '');
        if (dialDigits && numberDigits.startsWith(dialDigits)) numberDigits = numberDigits.slice(dialDigits.length);
        else numberDigits = numberDigits.replace(/^0+/, '');
        const formattedNumber = numberDigits.match(/\d{1,3}/g)?.join(' ') || '';
        walletPhoneEl.textContent = phone
            ? `${dialCode ? `${dialCode} ` : ''}${formattedNumber || phone}`
            : '';
        walletPhoneEl.hidden = !phone;
    }
    if (walletCardholderNameEl) walletCardholderNameEl.textContent = currentUserDisplayName || currentUser || '';
    if (!avatarEl) return;
    if (profileImage) {
        avatarEl.innerHTML = `<img src="${escapeHtml(profileImage)}" alt="${escapeHtml(currentUserDisplayName || currentUser)}">`;
        avatarEl.style.background = 'transparent';
    } else {
        avatarEl.innerHTML = getInitials(currentUserDisplayName || currentUser);
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
    el.textContent = `${timeGreeting}, ${(currentUserDisplayName || currentUser).trim()}`;
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
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatUsers" data-target="0">0</div><div class="summary-stat-label">Total Users</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatRegistrations" data-target="0">0</div><div class="summary-stat-label">Pending Registrations</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatTransactions" data-target="0">0</div><div class="summary-stat-label">Pending Transactions</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatLoans" data-target="0">0</div><div class="summary-stat-label">Pending Loans</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatActiveLoans" data-target="0">0</div><div class="summary-stat-label">Active Loans</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatSavings" data-target="0">KES 0</div><div class="summary-stat-label">Total Savings</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatOutstanding" data-target="0">KES 0</div><div class="summary-stat-label">Outstanding Loans</div></div>
                    <div class="summary-stat"><div class="summary-stat-value" id="devStatSubscriptions" data-target="0">0</div><div class="summary-stat-label">Push Subscriptions</div></div>
                </div>
            `;
            animateCountUp(document.getElementById('devStatUsers'), s.totalUsers, '');
            animateCountUp(document.getElementById('devStatRegistrations'), s.pendingRegistrations, '');
            animateCountUp(document.getElementById('devStatTransactions'), s.pendingTransactions, '');
            animateCountUp(document.getElementById('devStatLoans'), s.pendingLoans, '');
            animateCountUp(document.getElementById('devStatActiveLoans'), s.activeLoans, '');
            animateCountUp(document.getElementById('devStatSavings'), s.totalSavings || 0);
            animateCountUp(document.getElementById('devStatOutstanding'), s.outstandingLoans || 0);
            animateCountUp(document.getElementById('devStatSubscriptions'), s.pushSubscriptions, '');
        }
    } catch (e) {
        container.innerHTML = '<div class="empty-state">Error loading stats</div>';
    }
}

async function loadAllUsersFull(containerId = 'allUsersList') {
    const container = document.getElementById(containerId);
    if (!container) return;
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
                                            ${isDeveloper() ? `<option value="developer" ${user.role === 'developer' ? 'selected' : ''}>Developer</option>` : ''}
                                        </select>
                                        ${user.role === 'developer' ? '<span class="protected-user-label">Protected developer</span>' : `<button aria-label="Delete user" onclick="deleteUser('${user.email}')" style="background: #E5484D; color: white; width: auto; padding: 4px 10px; font-size: 11px; margin-top: 4px;">Delete</button>`}
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
            const registrations = [...res.registrations, ...(res.joinRequests || []).filter(request =>
                !res.registrations.some(registration => registration.email.toLowerCase() === request.email.toLowerCase())
            )];
            if (registrations.length === 0) {
                container.innerHTML = '<div class="empty-state">No pending registrations</div>';
                return;
            }
            container.innerHTML = registrations.map(reg => `
                <div class="pending-item" style="background: #FFF8E1; border-left: 4px solid #FF9800;">
                    <div><strong> ${escapeHtml(reg.name)}</strong></div>
                    <div> ${escapeHtml(reg.email)}</div>
                    <div> ${reg.created_at ? new Date(reg.created_at).toLocaleDateString() : ''}</div>
                    <div style="margin-top: 10px; display: flex; gap: 8px;">
                        <button class="approve-btn" onclick="approveRegistration('${encodeURIComponent(reg.email).replace(/'/g, '%27')}')"> Approve</button>
                        <button class="reject-btn" onclick="rejectRegistration('${encodeURIComponent(reg.email).replace(/'/g, '%27')}')"> Reject</button>
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
            showToast(`Role updated for ${email}`, 'success');
            await loadAllUsersFull();
            await loadAllUsersFull('adminAllUsersList');
            await loadSystemStats();
        } else {
            showToast(res.error || 'Error updating role', 'error');
        }
    } catch (e) {
        showToast('Error updating role', 'error');
    }
}

function openAddUserModal() {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content" role="dialog" aria-modal="true" aria-labelledby="addUserTitle">
        <h3 id="addUserTitle">Add group user</h3>
        <p class="modal-description">Create an approved member profile. They can sign in with Google using this email.</p>
        <div class="form-grid">
            <div><label for="newUserName">Full name</label><input id="newUserName" type="text" maxlength="80" placeholder="e.g. Jane Wanjiku"></div>
            <div><label for="newUserEmail">Google email</label><input id="newUserEmail" type="email" maxlength="254" placeholder="jane@example.com"></div>
        </div>
        <div class="modal-buttons"><button type="button" onclick="createGroupUser(this)">Add user</button><button type="button" class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button></div>
    </div>`;
    document.body.appendChild(modal);
}

async function createGroupUser(button) {
    const modal = button.closest('.modal');
    const name = modal.querySelector('#newUserName').value.trim();
    const email = modal.querySelector('#newUserEmail').value.trim();
    if (!name || !email) { showToast('Enter a name and Google email.', 'error'); return; }
    button.disabled = true;
    try {
        const result = await callAPI('createUser', { name, email });
        if (!result.success) throw new Error(result.error || 'Could not add this user.');
        modal.remove();
        showToast('User added successfully.', 'success');
        await loadAllUsersFull('adminAllUsersList');
        await loadAllUsersFull();
    } catch (error) {
        showToast(error.message || 'Could not add this user.', 'error');
        button.disabled = false;
    }
}

async function exportAuditLog() {
    const button = document.querySelector('.admin-download-log-button');
    if (button) { button.disabled = true; button.textContent = 'Preparing...'; }
    try {
        const result = await callAPI('exportAuditLog');
        if (!result.success) throw new Error(result.error || 'Could not download the audit log.');
        const escapeCell = value => {
            const text = String(value ?? '');
            return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        const lines = ['NBFA GROUP — Complete Activity Log', `Exported: ${new Date().toLocaleString('en-KE')}`, '', ['Timestamp', 'Actor', 'Action', 'Details'].map(escapeCell).join(','), ...result.entries.map(entry => [entry.timestamp, entry.actor, entry.action, entry.details].map(escapeCell).join(','))];
        const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `NBFA_GROUP_Audit_Log_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`Downloaded ${result.entries.length} log entries.`, 'success');
    } catch (error) {
        showToast(error.message || 'Could not download the audit log.', 'error');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Download full log'; }
    }
}

async function deleteUser(email) {
    if (!confirm(`Delete user ${email}? This action cannot be undone!`)) return;
    if (!confirm(`Are you absolutely sure?`)) return;
    try {
        const res = await callAPI('deleteUser', { email, requesterEmail: currentUserEmail });
        if (res.success) {
            showToast(` ${email} deleted successfully`, 'success');
            await loadAllUsersFull();
            await loadAllUsersFull('adminAllUsersList');
            await loadSystemStats();
        } else {
            showToast(res.error || 'Error deleting user', 'error');
        }
    } catch (e) {
        showToast('Error deleting user', 'error');
    }
}

async function approveRegistration(email) {
    try {
        email = decodeURIComponent(email);
        if (!confirm(`Approve ${email}?`)) return;
        const res = await callAPI('approveRegistration', { email, approvedBy: currentUser });
        if (res.success) {
            showToast(` ${email} approved!`, 'success');
            await loadDevPendingRegistrations();
            await loadPendingRegistrations();
            await loadAllUsersFull();
            await loadGroupMessages();
            if (isDeveloper()) await loadSystemStats();
        } else {
            showToast(res.error || 'Error approving', 'error');
        }
    } catch (e) {
        showToast('Error approving registration', 'error');
    }
}

async function rejectRegistration(email) {
    try {
        email = decodeURIComponent(email);
        if (!confirm(`Reject ${email}?`)) return;
        const res = await callAPI('rejectRegistration', { email, rejectedBy: currentUser });
        if (res.success) {
            showToast(` ${email} rejected`, 'success');
            await loadDevPendingRegistrations();
            await loadPendingRegistrations();
            await loadAllUsersFull();
            await loadGroupMessages();
            if (isDeveloper()) await loadSystemStats();
        } else {
            showToast(res.error || 'Error rejecting', 'error');
        }
    } catch (e) {
        showToast('Error rejecting registration', 'error');
    }
}

async function refreshAllData() {
    showToast('Refreshing all data...', 'success');
    try {
        const res = await callAPI('refreshAllData', { email: currentUserEmail });
        if (res.success) {
            showToast('All data refreshed!', 'success');
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
    showToast('Export feature coming soon', 'info');
}

function clearSystemCache() {
    if (!confirm('Reload the app? Your account and saved records will not be cleared.')) return;
    location.reload();
}

function auditIconFor(action) {
    const a = (action || '').toLowerCase();
    if (a.includes('logged in')) return 'IN';
    if (a.includes('joined')) return 'JO';
    if (a.includes('password')) return 'PW';
    if (a.includes('photo')) return 'PH';
    if (a.includes('approved')) return 'OK';
    if (a.includes('rejected')) return 'NO';
    if (a.includes('requested') || a.includes('submitted')) return 'RQ';
    if (a.includes('due date')) return 'DT';
    return 'LG';
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
            const registrations = [...res.registrations, ...(res.joinRequests || []).filter(request =>
                !res.registrations.some(registration => registration.email.toLowerCase() === request.email.toLowerCase())
            )];
            if (registrations.length === 0) {
                container.innerHTML = '<div class="empty-state">No pending registrations</div>';
                return;
            }
            container.innerHTML = registrations.map(reg => `
                <div class="pending-item" style="background: #FFF8E1; border-left: 4px solid #FF9800;">
                    <div><strong> ${escapeHtml(reg.name)}</strong></div>
                    <div> ${escapeHtml(reg.email)}</div>
                    <div> ${reg.created_at ? new Date(reg.created_at).toLocaleDateString() : ''}</div>
                    <div style="margin-top: 10px; display: flex; gap: 8px;">
                        <button class="approve-btn" onclick="approveRegistration('${encodeURIComponent(reg.email).replace(/'/g, '%27')}')"> Approve</button>
                        <button class="reject-btn" onclick="rejectRegistration('${encodeURIComponent(reg.email).replace(/'/g, '%27')}')"> Reject</button>
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
    if (DEVELOPMENT_PREVIEW_ENABLED) {
        dashboardLoaded = true;
        renderRecentActivity();
        updateAboutStats();
        renderWalletBalance();
        return;
    }
    isLoading = true;
    if (!silent && !skipBalanceUI) showBalanceLoading(true);
    try {
        const dash = await callAPI('getDashboardData', {
            includePending: (isTreasurer() || isDeveloper()) ? 'true' : 'false',
            isTreasurer: (isTreasurer() || isDeveloper()) ? 'true' : 'false',
            includeLoanTracking: silent ? 'false' : 'true'
        });
        if (!dash.success) throw new Error(dash.error || 'Failed to load dashboard data');

        dashboardLoaded = true;
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

        if (currentTab !== 'loans') {
            const allLoans = dash.loans || [];
            const requiredApprovals = loan => Number.isFinite(Number(loan.approvalsRequired))
                ? Number(loan.approvalsRequired)
                : Math.max(allMembers.length - 1, 1);
            pendingLoans = allLoans.filter(l => l.approvals.length < requiredApprovals(l) && l.status !== 'completed' && l.status !== 'rejected');
            completedLoans = allLoans.filter(l => l.approvals.length >= requiredApprovals(l) || l.status === 'completed');
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

let isLoansLoading = false;
function updateLoanEstimate() {
    const input = document.getElementById('loanEstimatePrincipal');
    const principal = Math.max(0, Math.round(Number(input?.value) || 0));
    const interest = Math.round(principal * 0.1);
    const formatKes = value => `KES ${value.toLocaleString('en-KE')}`;
    const principalEl = document.getElementById('loanEstimatePrincipalDisplay');
    const interestEl = document.getElementById('loanEstimateInterest');
    const totalEl = document.getElementById('loanEstimateTotal');
    if (principalEl) principalEl.textContent = formatKes(principal);
    if (interestEl) interestEl.textContent = formatKes(interest);
    if (totalEl) totalEl.textContent = formatKes(principal + interest);
}

async function loadLoansDashboard() {
    if (isLoansLoading || !currentUser) return;
    if (DEVELOPMENT_PREVIEW_ENABLED) {
        pendingLoans = [];
        completedLoans = [];
        activeLoans = [];
        loansAwaitingDueDate = [];
        loanRequests = [];
        renderPendingLoans();
        renderCompletedLoans();
        renderActiveLoans();
        renderLoansAwaitingDueDate();
        renderLoanRequestHistory();
        return;
    }
    isLoansLoading = true;
    try {
        const result = await callAPI('getLoansDashboard');
        if (!result.success) throw new Error(result.error || 'Could not load loan information.');
        allMembers = result.members || [];
        const total = allMembers.length || 1;
        const loans = result.loans || [];
        const requiredApprovals = loan => Number.isFinite(Number(loan.approvalsRequired))
            ? Number(loan.approvalsRequired)
            : Math.max(total - 1, 1);
        pendingLoans = loans.filter(loan => loan.approvals.length < requiredApprovals(loan) && loan.status !== 'completed' && loan.status !== 'rejected');
        completedLoans = loans.filter(loan => loan.approvals.length >= requiredApprovals(loan) || loan.status === 'completed');
        activeLoans = result.activeLoans || [];
        loansAwaitingDueDate = result.loansAwaitingDueDate || [];
        loanRequests = result.loanRequests || [];
        renderLoanRequestHistory();
        renderPendingLoans();
        renderCompletedLoans();
        renderActiveLoans();
        renderLoansAwaitingDueDate();
    } catch (error) {
        console.error('Error loading loans:', error);
        ['activeLoansList', 'pendingLoans', 'completedLoans', 'awaitingDueDateList'].forEach(id => {
            const container = document.getElementById(id);
            if (container) {
                container.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Could not load loan information.')}</div>`;
                const section = container.closest('.loans-section');
                if (section && section.id !== 'awaitingDueDateCard') section.hidden = false;
            }
        });
        const history = document.getElementById('loanRequestHistory');
        if (history) history.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Could not load loan request history.')}</div>`;
    } finally {
        isLoansLoading = false;
    }
}

function requestEstimatedLoan() {
    const principal = Math.max(0, Math.round(Number(document.getElementById('loanEstimatePrincipal')?.value) || 0));
    if (!principal) {
        showToast('Enter a loan amount to request.', 'error');
        document.getElementById('loanEstimatePrincipal')?.focus();
        return;
    }
    openAddTransactionModal('Loan Taken');
    const amount = document.getElementById('amount');
    if (amount) amount.value = String(principal);
    document.getElementById('message')?.focus();
}

function renderLoanRequestHistory() {
    const container = document.getElementById('loanRequestHistory');
    if (!container) return;
    if (!loanRequests.length) {
        container.innerHTML = '<div class="loan-history-empty"><strong>No loan requests yet</strong><span>New requests and their approval progress will appear here for the group.</span></div>';
        return;
    }
    container.innerHTML = loanRequests.map(request => {
        const principal = Number(request.principal ?? request.amount) || 0;
        const interest = Number(request.interest) || Math.round(principal * 0.1);
        const total = Number(request.totalDue) || principal + interest;
        const approvals = Array.isArray(request.approvals) ? request.approvals : [];
        const required = Math.max(Number(request.approvalsRequired) || (allMembers.length - 1), 1);
        const ownRequest = request.isRequester !== undefined ? Boolean(request.isRequester) : request.member === currentUser;
        const status = request.status === 'rejected'
            ? 'Declined'
            : request.status === 'cancelled'
                ? 'Cancelled'
            : ['approved', 'active'].includes(request.status)
                ? (request.status === 'active' ? 'Active loan' : 'Approved — awaiting due date')
                : 'Awaiting member approvals';
        const statusClass = ['rejected', 'cancelled'].includes(request.status)
            ? 'is-rejected'
            : ['approved', 'active'].includes(request.status) ? 'is-approved' : 'is-pending';
        const isResolved = ['rejected', 'cancelled'].includes(request.status);
        const date = request.createdAt ? new Date(request.createdAt).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
        return `<article class="loan-history-item ${ownRequest ? 'is-own-request' : ''}">
            <div class="loan-history-topline"><div><span class="section-kicker">${ownRequest ? 'YOUR REQUEST' : 'GROUP REQUEST'}</span><h3>${escapeHtml(request.member || 'Group member')} · KES ${principal.toLocaleString('en-KE')}</h3></div><span class="loan-history-status ${statusClass}">${status}</span></div>
            <p class="loan-history-details">${escapeHtml(request.message || 'No purpose supplied')} · Requested total KES ${total.toLocaleString('en-KE')} (KES ${interest.toLocaleString('en-KE')} interest)</p>
            <div class="loan-history-meta">${date ? `<span>Submitted ${date}</span>` : ''}${request.requestedDueDate ? `<span>Requested repayment by ${escapeHtml(request.requestedDueDate)}</span>` : ''}${request.dueDate ? `<span>Confirmed due date ${escapeHtml(request.dueDate)}</span>` : ''}${!isResolved ? `<span>${approvals.length} of ${required} approvals</span>` : ''}</div>
            ${!isResolved ? `<div class="loan-history-progress" role="progressbar" aria-valuenow="${Math.min(approvals.length, required)}" aria-valuemin="0" aria-valuemax="${required}"><span style="width:${Math.min(100, approvals.length / required * 100)}%"></span></div>` : ''}
            ${approvals.length ? `<p class="loan-history-votes"><strong>Approved by</strong> ${escapeHtml(approvals.join(', '))}</p>` : ''}
            ${request.status === 'rejected' ? `<p class="loan-history-reason"><strong>Decline reason:</strong> ${escapeHtml(request.rejectionReason || 'No reason provided')}</p>` : ''}
            ${request.status === 'cancelled' ? '<p class="loan-history-votes">This request was cancelled.</p>' : ''}
        </article>`;
    }).join('');
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
    const value = Number(newValue);
    const target = Number.isFinite(value) ? value : 0;
    const from = Number.isFinite(prevTarget) ? prevTarget : 0;
    el.setAttribute('data-target', target);
    const activeFrame = countUpFrames.get(el);
    if (activeFrame) cancelAnimationFrame(activeFrame);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        countUpFrames.delete(el);
        el.textContent = `${prefix}${target.toLocaleString('en-KE')}`;
        return;
    }
    if (from === target) {
        countUpFrames.delete(el);
        el.textContent = `${prefix}${target.toLocaleString('en-KE')}`;
        return;
    }
    const duration = 1050;
    const start = performance.now();
    function tick(now) {
        const elapsed = now - start;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 4);
        const current = Math.round(from + (target - from) * eased);
        el.textContent = `${prefix}${current.toLocaleString('en-KE')}`;
        if (progress < 1) {
            countUpFrames.set(el, requestAnimationFrame(tick));
        } else {
            countUpFrames.delete(el);
        }
    }
    countUpFrames.set(el, requestAnimationFrame(tick));
}

function toggleWalletScopeMenu() {
    const menu = document.getElementById('walletScopeMenu');
    const button = document.getElementById('walletScopeChip');
    if (!menu || !button) return;
    const open = menu.style.display === 'none';
    menu.style.display = open ? 'block' : 'none';
    button.setAttribute('aria-expanded', String(open));
}

function setWalletScope(scope) {
    if (scope !== 'group' && scope !== 'mine') return;
    walletScope = scope;
    document.getElementById('walletScopeLabel').textContent = scope === 'mine' ? 'Mine' : 'Group';
    document.getElementById('walletBalanceLabel').textContent = scope === 'mine'
        ? 'Your savings balance'
        : 'Available group balance';
    document.querySelectorAll('#walletScopeMenu [data-scope]').forEach(option => {
        const selected = option.dataset.scope === scope;
        option.classList.toggle('active', selected);
        option.setAttribute('aria-pressed', String(selected));
    });
    document.getElementById('walletScopeMenu').style.display = 'none';
    document.getElementById('walletScopeChip').setAttribute('aria-expanded', 'false');
    renderWalletBalance();
}

document.addEventListener('click', (e) => {
    const wrapper = document.getElementById('walletScopeChip')?.closest('.wallet-scope-wrapper');
    const menu = document.getElementById('walletScopeMenu');
    if (wrapper && menu && menu.style.display !== 'none' && !wrapper.contains(e.target)) {
        menu.style.display = 'none';
        document.getElementById('walletScopeChip')?.setAttribute('aria-expanded', 'false');
    }
});

async function downloadWalletCard() {
    if (typeof html2pdf !== 'function') {
        showToast('Card download is unavailable. Check your connection and try again.', 'error');
        return;
    }
    const source = document.querySelector('.dashboard-top-grid > .header');
    if (!source) {
        showToast('The group card could not be found.', 'error');
        return;
    }
    const exportStage = document.createElement('div');
    exportStage.className = 'dashboard-top-grid wallet-card-export-stage';
    const card = source.cloneNode(true);
    card.classList.add('wallet-card-exporting');
    card.querySelector('.wallet-card-download')?.remove();
    const image = card.querySelector('.wallet-profile-image');
    if (image && !image.hidden && image.src) {
        image.crossOrigin = 'anonymous';
        image.src = source.querySelector('.wallet-profile-image').src;
    }
    exportStage.appendChild(card);
    document.body.appendChild(exportStage);
    try {
        await Promise.all([...card.querySelectorAll('img')]
            .filter(img => !img.hidden && (img.currentSrc || img.src))
            .map(img => img.decode()));
        const accountName = (currentUserDisplayName || currentUser || 'Member')
            .trim()
            .replace(/[^A-Za-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'Member';
        const filename = `${accountName}_NBFA_GROUP_Card_${getLocalDateInputValue()}.pdf`;
        await html2pdf().set({
            margin: 0,
            filename,
            image: { type: 'png' },
            html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: null, windowWidth: 856, scrollX: 0, scrollY: 0 },
            jsPDF: { unit: 'mm', format: [85.6, 54], orientation: 'landscape' }
        }).from(card).save();
        showToast('Your NBFA GROUP card was downloaded.', 'success');
    } catch (error) {
        console.error('Card download failed:', error);
        showToast('Could not download the card. Please try again.', 'error');
    } finally {
        exportStage.remove();
    }
}

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
    container.classList.remove('loading-container');
    if (!allRecords.length) {
        container.classList.remove('has-recent-activity');
        container.classList.remove('has-fade-activity');
        container.innerHTML = '<div class="empty-state">No transactions yet</div>';
        return;
    }
    container.classList.add('has-recent-activity');
    const recent = [...allRecords].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 5);
    container.classList.toggle('has-fade-activity', recent.length > 2);
    const iconFor = type => {
        if (type === 'Savings') {
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18m6-14.5c-.8-1-2.1-1.5-4-1.5h-4a3 3 0 0 0 0 6h4a3 3 0 0 1 0 6H9c-1.7 0-2.9-.5-3.8-1.5"/></svg>';
        }
        if (type === 'Loan Taken') {
            return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7.5h15a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2h13"/><path d="M3 10h18m-5 5h2"/></svg>';
        }
        return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.2 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 17.8 15"/></svg>';
    };
    container.innerHTML = `<div class="recent-activity-stack">${recent.map((r, index) => {
        const sign = r.type === 'Loan Taken' ? '-' : '+';
        const date = new Date(r.date);
        const dateLabel = Number.isNaN(date.getTime())
            ? ''
            : date.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
        const activityType = ['Savings', 'Loan Taken', 'Loan Repayment'].includes(r.type) ? r.type : 'Transaction';
        const iconClass = r.type === 'Savings'
            ? 'savings'
            : r.type === 'Loan Taken'
                ? 'loan'
                : 'repayment';
        return `<div class="activity-row${index > 1 ? ` activity-row--fade-${Math.min(index, 4)}` : ''}">
            <div class="activity-icon activity-icon--${iconClass}">${iconFor(r.type)}</div>
            <div class="activity-info">
                <div class="activity-name">${escapeHtml(r.member)}</div>
                <div class="activity-meta"><span>${escapeHtml(activityType)}</span>${dateLabel ? `<span class="activity-meta-separator" aria-hidden="true"></span><time>${dateLabel}</time>` : ''}</div>
            </div>
            <div class="activity-amount ${sign === '-' ? 'negative' : 'positive'}">${sign} KES ${Number(r.amount || 0).toLocaleString('en-KE')}</div>
        </div>`;
    }).join('')}</div>`;
}

function renderPendingLoans() {
    const container = document.getElementById('pendingLoans');
    if (!container) return;
    const section = container.closest('.loans-section');
    if (section) section.hidden = pendingLoans.length === 0;
    if (!pendingLoans.length) { container.replaceChildren(); return; }
    container.innerHTML = pendingLoans.map(loan => {
        const isRequester = loan.isRequester !== undefined ? Boolean(loan.isRequester) : loan.member === currentUser;
        const approvals = Array.isArray(loan.approvals) ? loan.approvals : [];
        const alreadyApproved = loan.viewerHasApproved !== undefined
            ? Boolean(loan.viewerHasApproved)
            : approvals.includes(currentUser);
        const showButtons = !isRequester && !alreadyApproved;
        const totalNeeded = Math.max(Number(loan.approvalsRequired) || (allMembers.length - 1), 1);
        const percent = totalNeeded > 0 ? (approvals.length / totalNeeded) * 100 : 100;
        return `<div class="loan-item ${isRequester ? 'own-loan' : ''}">
            <div><strong>${escapeHtml(loan.member)}</strong> requested <strong>KES ${(loan.principal || 0).toLocaleString('en-KE')}</strong> + 10% = <strong>KES ${(loan.totalDue || 0).toLocaleString('en-KE')}</strong>${isRequester ? ' (Your request)' : (alreadyApproved ? ' (You approved)' : '')}</div>
            <div style="font-size:12px;">${escapeHtml(loan.message || '')}</div>
            ${loan.requestedDueDate ? `<div style="font-size:11px; margin-top:5px;">Requested repayment date: ${escapeHtml(loan.requestedDueDate)}</div>` : ''}
            <div style="font-size:11px; margin-top:5px;">Approvals: ${approvals.length}/${totalNeeded}${isRequester ? ' (you cannot approve your own request)' : ''}</div>
            <div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(percent, 100)}%;"></div></div>
            ${showButtons ? `<div style="margin-top:8px; display:flex; gap:8px;"><button class="approve-btn" onclick="approveLoan('${loan.id}')">Approve request</button><button class="reject-btn" onclick="rejectLoan('${loan.id}')">Decline with reason</button></div>` : ''}
            ${isRequester && loan.status === 'pending' ? `<div style="margin-top:8px;"><button class="cancel-btn" onclick="cancelLoanRequest('${loan.id}')"> Cancel Request</button></div>` : ''}
        </div>`;
    }).join('');
}

function renderCompletedLoans() {
    const container = document.getElementById('completedLoans');
    if (!container) return;
    const section = container.closest('.loans-section');
    if (section) section.hidden = completedLoans.length === 0;
    if (!completedLoans.length) { container.replaceChildren(); return; }
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
    const section = container.closest('.loans-section');
    if (section) section.hidden = stillOwed.length === 0;
    if (!stillOwed.length) { container.replaceChildren(); return; }
    container.innerHTML = stillOwed.map(loan => {
        const isMine = loan.member === currentUser;
        const overdueClass = loan.isOverdue ? 'loan-overdue' : '';
        const progressPct = loan.totalDue > 0 ? Math.min(100, (loan.amountRepaid / loan.totalDue) * 100) : 0;
        return `<div class="active-loan-item ${overdueClass} ${isMine ? 'own-loan' : ''}">
            <div class="active-loan-header"><strong>${escapeHtml(loan.member)}</strong>${loan.isOverdue ? '<span class="overdue-badge"> Overdue</span>' : ''}</div>
            <div class="active-loan-amounts"><span>Owed: KES ${loan.remaining.toLocaleString('en-KE')}</span><span class="active-loan-total">of KES ${loan.totalDue.toLocaleString('en-KE')}</span></div>
            <div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%;"></div></div>
            <div class="active-loan-due"> Due: ${loan.dueDate || 'Not set'}</div>
        </div>`;
    }).join('');
}

function renderLoansAwaitingDueDate() {
    const container = document.getElementById('awaitingDueDateList');
    const card = document.getElementById('awaitingDueDateCard');
    if (!container) return;
    if (!isTreasurer() && !isDeveloper()) {
        if (card) card.hidden = true;
        return;
    }
    if (card) {
        card.hidden = loansAwaitingDueDate.length === 0;
        card.style.display = loansAwaitingDueDate.length ? 'block' : 'none';
    }
    if (!loansAwaitingDueDate.length) {
        container.replaceChildren();
        return;
    }
    container.innerHTML = loansAwaitingDueDate.map(loan => {
        const interest = Math.round((loan.principal || 0) * 0.10);
        const totalDue = (loan.principal || 0) + interest;
        const requestDate = loan.date ? new Date(`${loan.date}T00:00:00`) : null;
        if (requestDate && !Number.isNaN(requestDate.getTime())) requestDate.setDate(requestDate.getDate() + 1);
        const earliestDueDate = requestDate && !Number.isNaN(requestDate.getTime()) ? getLocalDateInputValue(requestDate) : '';
        return `<div class="loan-item">
            <div><strong>${escapeHtml(loan.member)}</strong> — KES ${(loan.principal || 0).toLocaleString('en-KE')} + 10% = <strong>KES ${totalDue.toLocaleString('en-KE')}</strong></div>
            <div style="font-size:12px; margin-top:4px;">${escapeHtml(loan.message || '')}</div>
            <div class="form-grid" style="margin-top:10px; margin-bottom:8px;">
                <div><label>Confirm repayment due date</label><input type="date" id="dueDateInput-${loan.id}" min="${escapeHtml(earliestDueDate)}" value="${escapeHtml(loan.requestedDueDate || '')}"></div>
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
        const editBadge = editInfo ? `<div style="background:var(--blue-soft);color:var(--blue);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;margin-bottom:8px;display:inline-block;"> EDIT REQUEST — was KES ${editInfo.originalAmount.toLocaleString('en-KE')}</div><br>` : '';
        const rejectFn = editInfo ? `rejectTransactionEdit('${editInfo.editId}', '${currentUser}')` : `rejectTransaction('${t.id}')`;
        return `<div class="pending-item">
            ${editBadge}
            <div><strong> ${t.date}</strong></div>
            <div> <strong>Submitted by:</strong> ${escapeHtml(t.submittedBy || t.member)}</div>
            <div> <strong>Type:</strong> ${t.type}</div>
            <div> <strong>Amount:</strong> KES ${(t.amount || 0).toLocaleString('en-KE')}</div>
            <div> <strong>Message:</strong> ${escapeHtml(t.message || '-')}</div>
            <div style="margin-top: 10px; display: flex; gap: 8px;">
                <button class="approve-btn" onclick="approveTransaction('${t.id}')"> Approve</button>
                <button class="reject-btn" onclick="${rejectFn}"> Reject</button>
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
        type === 'Savings' ? 'New Deposit' : type === 'Loan Taken' ? 'Request a Loan' : 'Repay a Loan';
    toggleApprovalNotice();
    if (!document.getElementById('date').value) {
        document.getElementById('date').value = getLocalDateInputValue();
    }
    updateLoanRequestedDueDateMinimum();
    modal.tabIndex = -1;
    modal.onclick = event => {
        if (event.target === modal) closeAddTransactionModal();
    };
    modal.onkeydown = event => {
        if (event.key === 'Escape') closeAddTransactionModal();
    };
    modal.style.display = 'flex';
    modal.querySelector('.modal-content')?.focus({ preventScroll: true });
}

function closeAddTransactionModal() {
    const modal = document.getElementById('addTransactionModal');
    if (modal) modal.style.display = 'none';
}

function toggleApprovalNotice() {
    const type = document.getElementById('type').value;
    const isLoanRequest = type === 'Loan Taken';
    document.getElementById('approvalNotice').style.display = isLoanRequest ? 'block' : 'none';
    const dueDateWrapper = document.getElementById('loanRequestedDueDateWrapper');
    const dueDateInput = document.getElementById('loanRequestedDueDate');
    const messageInput = document.getElementById('message');
    const messageLabel = document.getElementById('transactionMessageLabel');
    if (dueDateWrapper) dueDateWrapper.style.display = isLoanRequest ? 'block' : 'none';
    if (dueDateInput) {
        dueDateInput.required = isLoanRequest;
        document.getElementById('date').onchange = updateLoanRequestedDueDateMinimum;
        updateLoanRequestedDueDateMinimum();
    }
    if (messageInput) {
        messageInput.required = isLoanRequest;
        messageInput.placeholder = isLoanRequest ? 'e.g., School fees or medical expenses' : 'e.g., Bank/Mpesa Message';
    }
    if (messageLabel) messageLabel.textContent = isLoanRequest ? 'What is the loan for? *' : 'Transaction Message';
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
    const requestedDueDate = document.getElementById('loanRequestedDueDate')?.value || '';
    if (!date || !amount || amount <= 0) { showToast('Please fill all fields', 'error'); return; }
    if (type === 'Loan Taken') {
        if (message.trim().length < 3) { showToast('Describe what the loan will be used for.', 'error'); return; }
        if (!requestedDueDate || requestedDueDate <= date) {
            showToast('Choose a requested repayment date after the request date.', 'error');
            return;
        }
    }
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
        const res = await callAPI('submitLoan', { date, member, amount, message: message.trim(), requestedDueDate, notes: '', requestedBy: currentUser });
        if (res.success) {
            const approvalsRequired = Number.isFinite(Number(res.approvalsRequired))
                ? Number(res.approvalsRequired)
                : Math.max(allMembers.length - 1, 1);
            showToast(`Loan request submitted! Needs ${approvalsRequired} other approval${approvalsRequired === 1 ? '' : 's'}.`, 'success');
            document.getElementById('amount').value = '';
            document.getElementById('message').value = '';
            document.getElementById('loanRequestedDueDate').value = '';
            closeAddTransactionModal();
            await loadAllData();
            await loadLoansDashboard();
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
        const remaining = Math.max((res.approvalsRequired ?? allMembers.length - 1) - (res.approvals || 0), 0);
        showToast(remaining > 0 ? `Approved! Need ${remaining} more` : `Loan fully approved!`, 'success');
        await loadAllData();
        await loadLoansDashboard();
    } else { showToast('Error: ' + res.error, 'error'); }
    hideButtonLoading(btn, orig);
}

function showLoanRejectionDialog() {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal loan-decision-modal';
        overlay.innerHTML = `<section class="modal-content loan-decision-content" role="dialog" aria-modal="true" aria-labelledby="loanDeclineTitle">
            <span class="section-kicker">MEMBER DECISION</span>
            <h3 id="loanDeclineTitle">Decline this loan request?</h3>
            <p>Your reason will be saved in the group loan history and shared in the group inbox.</p>
            <label for="loanDeclineReason">Reason for declining *</label>
            <textarea id="loanDeclineReason" maxlength="500" placeholder="Share a clear, respectful reason (at least 3 characters)."></textarea>
            <div class="modal-buttons">
                <button type="button" class="close-modal loan-decline-cancel">Keep request open</button>
                <button type="button" class="loan-decline-submit">Decline request</button>
            </div>
        </section>`;
        const previousOverflow = document.body.style.overflow;
        const finish = value => {
            document.removeEventListener('keydown', handleKeydown);
            document.body.style.overflow = previousOverflow;
            overlay.remove();
            resolve(value);
        };
        const handleKeydown = keyboardEvent => {
            if (keyboardEvent.key === 'Escape') finish(null);
        };
        overlay.addEventListener('click', clickEvent => {
            if (clickEvent.target === overlay) finish(null);
        });
        overlay.querySelector('.loan-decline-cancel').addEventListener('click', () => finish(null));
        overlay.querySelector('.loan-decline-submit').addEventListener('click', () => {
            const reason = overlay.querySelector('#loanDeclineReason').value.trim();
            if (reason.length < 3) {
                showToast('Please provide a reason of at least 3 characters.', 'error');
                overlay.querySelector('#loanDeclineReason').focus();
                return;
            }
            finish(reason);
        });
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleKeydown);
        document.body.appendChild(overlay);
        overlay.querySelector('#loanDeclineReason').focus();
    });
}

async function rejectLoan(loanId) {
    const reason = await showLoanRejectionDialog();
    if (!reason) return;
    const res = await callAPI('rejectLoan', { loanId, reason });
    if (res.success) {
        showToast('Decision recorded and shared with the group.', 'success');
        await loadAllData();
        await loadLoansDashboard();
    } else showToast('Error: ' + res.error, 'error');
}

async function cancelLoanRequest(loanId) {
    if (!confirm('Cancel this loan request?')) return;
    const btn = event.target;
    const orig = btn.innerHTML;
    showButtonLoading(btn, 'Cancelling...');
    const res = await callAPI('cancelLoan', { loanId });
    if (res.success) { showToast('Loan cancelled!', 'success'); await loadAllData(); await loadLoansDashboard(); }
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
        await loadLoansDashboard();
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
        const meetingSeenAt = localStorage.getItem(unreadStorageKey('meeting_updates')) || '';
        const latestMeetingDate = meetings.reduce((latest, meeting) => String(meeting.date || '') > latest ? String(meeting.date || '') : latest, '');
        unreadMeetingUpdates = Boolean(latestMeetingDate && new Date(`${latestMeetingDate}T23:59:59`).getTime() > new Date(meetingSeenAt || 0).getTime());
        updateUnreadIndicators();
        if (meetings.length === 0) {
            container.innerHTML = '<div class="empty-state">No meeting minutes recorded yet.</div>';
            return;
        }
        container.innerHTML = meetings.slice().reverse().map(meeting => {
            let countdownHtml = '';
            if (meeting.nextMeeting) countdownHtml = `<div class="countdown-timer" data-date="${meeting.nextMeeting}"> Loading countdown...</div>`;
            return `<div class="meeting-item">
                <div class="meeting-header"><span class="meeting-date"> ${escapeHtml(meeting.date)}</span><span class="meeting-author">by ${escapeHtml(meeting.recordedBy)}</span></div>
                <div class="meeting-section"><div class="meeting-section-title"> Agenda:</div><div class="meeting-section-content">${escapeHtml(meeting.agenda)}</div></div>
                <div class="meeting-section"><div class="meeting-section-title"> Notes:</div><div class="meeting-section-content">${escapeHtml(meeting.notes || 'No notes')}</div></div>
                <div class="meeting-section"><div class="meeting-section-title"> Decisions:</div><div class="meeting-section-content">${escapeHtml(meeting.decisions || 'None')}</div></div>
                ${meeting.nextMeeting ? `<div class="meeting-section"><div class="meeting-section-title"> Next Meeting:</div><div class="meeting-section-content">${escapeHtml(meeting.nextMeeting)}</div>${countdownHtml}</div>` : ''}
                ${isTreasurer() || isDeveloper() ? `<button class="delete-meeting-btn" onclick="deleteMeeting('${meeting.id}')"> Delete Meeting</button>` : ''}
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
            <h3 style="margin:0;"> Meeting Minutes</h3>
            <button onclick="openAddMeetingModal()" style="width:auto; padding:7px 14px; font-size:12px;">+ Add</button>
        </div>
        <div id="meetingMinutesList" class="loading-container"><div class="loading-spinner"></div><div>Loading...</div></div>
        <div class="modal-buttons"><button class="close-modal" onclick="this.closest('.modal').remove()">Close</button></div>
    </div>`;
    document.body.appendChild(modal);
    loadMeetingMinutes();
}

function openAddMeetingModal() {
    const today = getLocalDateInputValue();
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `<div class="modal-content">
        <h3> Add Meeting Minutes</h3>
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
            const meetingSeenAt = localStorage.getItem(unreadStorageKey('meeting_updates')) || '';
            unreadMeetingUpdates = unreadMeetingUpdates || new Date(`${res.meeting.date}T23:59:59`).getTime() > new Date(meetingSeenAt || 0).getTime();
            updateUnreadIndicators();
            card.style.display = 'block';
            info.innerHTML = `
                <div class="meeting-item" style="border-left-color: #3B6FF2; background: #F4F6FB;">
                    <div class="meeting-header"><span class="meeting-date"> ${escapeHtml(res.meeting.date)}</span></div>
                    <div class="meeting-section"><div class="meeting-section-title"> Agenda:</div><div class="meeting-section-content">${escapeHtml(res.meeting.agenda || 'Not set')}</div></div>
                    <div class="meeting-section"><div class="meeting-section-title"> Venue:</div><div class="meeting-section-content">${escapeHtml(res.meeting.venue || 'Not set')}</div></div>
                    <div class="countdown-timer" data-date="${res.meeting.date}"> Loading countdown...</div>
                    <div class="meeting-section" style="margin-top: 10px;"><div class="meeting-section-title"> Scheduled by:</div><div class="meeting-section-content">${escapeHtml(res.meeting.scheduledBy || 'Unknown')}</div></div>
                    ${isTreasurer() || isDeveloper() ? `<button class="delete-meeting-btn" onclick="cancelScheduledMeeting()" style="margin-top: 10px;"> Cancel Schedule</button>` : ''}
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
        <h3> Schedule Next Meeting</h3>
        <div class="form-grid">
            <div><label> Next Meeting Date</label><input type="date" id="nextMeetingDate"></div>
            <div><label> Meeting Agenda</label><input type="text" id="nextMeetingAgenda" placeholder="What will be discussed?"></div>
            <div><label> Venue / Location</label><input type="text" id="nextMeetingVenue" placeholder="e.g., Online / Hall"></div>
        </div>
        <div class="modal-buttons">
            <button id="scheduleMeetingBtn" onclick="scheduleNextMeetingAndClose()"> Schedule</button>
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
        if (diff <= 0) { el.innerHTML = 'Meeting is today!'; el.classList.add('urgent'); }
        else {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % 86400000) / (1000 * 60 * 60));
            const mins = Math.floor((diff % 3600000) / (1000 * 60));
            if (days > 0) el.innerHTML = `Countdown: ${days}d ${hours}h`;
            else if (hours > 0) { el.innerHTML = `Countdown: ${hours}h ${mins}m`; el.classList.add('urgent'); }
            else { el.innerHTML = `Countdown: ${mins}m`; el.classList.add('urgent'); }
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
        <h3> Send Announcement</h3>
        <div class="form-grid">
            <div style="grid-column: span 2;"><label>Title</label><input type="text" id="announcementTitle" placeholder="e.g., Meeting moved to 6pm" maxlength="80"></div>
            <div style="grid-column: span 2;"><label>Message</label><textarea id="announcementBody" rows="3" placeholder="Write your announcement here..." maxlength="500"></textarea></div>
        </div>
        <div class="modal-buttons">
            <button id="sendAnnouncementBtn" onclick="sendAnnouncementAndClose()"> Send to All</button>
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
    const title = titleInput ? ` ${titleInput}` : `Announcement from ${currentUser}`;
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
        <h3 style="margin-bottom:14px;"> Activity Log</h3>
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
    if (memberRollObserver) memberRollObserver.disconnect();
    if (memberRollAnimationFrame) cancelAnimationFrame(memberRollAnimationFrame);
    memberRollAnimationFrame = 0;
    memberRollContainer = null;
    if (!members || members.length === 0) {
        container.classList.remove('is-auto-scrolling', 'is-paused');
        container.innerHTML = '<div class="empty-state">No members found</div>';
        return;
    }
    const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));
    const memberCards = sortedMembers.map(member => {
        const initial = getInitials(member.name);
        const isTreas = member.name === TREASURER_NAME;
        const memberStats = getUserStats(member.name);
        if (member.image && member.email) memberPhotoCache[member.email.toLowerCase()] = member.image;
        const cachedPhoto = memberPhotoCache[member.email?.toLowerCase()];
        const avatarContent = cachedPhoto ? `<img src="${cachedPhoto}" alt="${escapeHtml(member.name)}">` : initial;
        return `<div class="member-card" onclick="viewMemberProfile('${escapeHtml(member.name)}', '${escapeHtml(member.email || '')}')">
            <div class="member-avatar" id="memberAvatar-${escapeHtml(member.email || '')}" data-member-email="${escapeHtml(member.email || '')}">${avatarContent}</div>
            <div class="member-card-info">
                <div class="member-name">${escapeHtml(member.name)}</div>
                <div class="member-role ${isTreas ? 'treasurer' : ''}">${isTreas ? 'Treasurer' : 'Member'}</div>
            </div>
            <div class="member-stats">
                <span class="member-stat"><span class="member-stat-label">Saved</span><strong>KES ${(memberStats.savings || 0).toLocaleString()}</strong></span>
                <span class="member-stat"><span class="member-stat-label">Loan balance</span><strong>KES ${(memberStats.loans || 0).toLocaleString()}</strong></span>
            </div>
        </div>`;
    }).join('');
    container.innerHTML = `<div class="members-track-group">${memberCards}</div>`;
    const duplicateGroup = container.firstElementChild.cloneNode(true);
    duplicateGroup.classList.add('members-track-group--duplicate');
    duplicateGroup.setAttribute('aria-hidden', 'true');
    duplicateGroup.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    duplicateGroup.querySelectorAll('[onclick]').forEach(element => element.removeAttribute('onclick'));
    container.appendChild(duplicateGroup);
    container.style.setProperty('--members-scroll-duration', `${Math.max(24, sortedMembers.length * 8)}s`);
    container.classList.add('is-auto-scrolling');
    memberRollContainer = container;
    if ('IntersectionObserver' in window) {
        memberRollObserver = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                scheduleMemberRollFocus();
            } else if (memberRollAnimationFrame) {
                cancelAnimationFrame(memberRollAnimationFrame);
                memberRollAnimationFrame = 0;
            }
        });
        memberRollObserver.observe(container.parentElement);
    } else {
        scheduleMemberRollFocus();
    }
    let photoFetchDelay = 0;
    sortedMembers.forEach(member => {
        if (!member.hasImage || !member.email) return;
        const emailKey = member.email.toLowerCase();
        if (memberPhotoCache[emailKey]) return;
        setTimeout(() => loadMemberPhoto(member.email), photoFetchDelay);
        photoFetchDelay += 200;
    });
}

function scheduleMemberRollFocus() {
    if (memberRollAnimationFrame || !memberRollContainer) return;
    memberRollAnimationFrame = requestAnimationFrame(updateMemberRollFocus);
}

function updateMemberRollFocus() {
    memberRollAnimationFrame = 0;
    const container = memberRollContainer;
    if (!container
        || document.hidden
        || memberRollReducedMotion.matches
        || container.classList.contains('is-paused')
        || !container.closest('.panel')?.classList.contains('active-panel')) return;

    const wrapper = container.parentElement;
    const center = wrapper.getBoundingClientRect().left + wrapper.clientWidth / 2;
    const focusStates = [...container.querySelectorAll('.member-card')].map(card => {
        const bounds = card.getBoundingClientRect();
        const distance = Math.abs(bounds.left + bounds.width / 2 - center);
        const proximity = Math.max(0, 1 - distance / (card.offsetWidth * 0.9));
        const focus = proximity * proximity * (3 - 2 * proximity);
        return { card, focus };
    });
    focusStates.forEach(({ card, focus }) => {
        card.style.setProperty('--member-focus-scale', (1 + focus * 0.28).toFixed(3));
        card.style.setProperty('--member-focus-lift', `${(-focus * 10).toFixed(2)}px`);
        card.style.setProperty('--member-focus-depth', `${(focus * 48).toFixed(2)}px`);
        card.style.setProperty('--member-focus-shadow', `0 24px 42px rgba(31, 63, 40, ${(0.05 + focus * 0.18).toFixed(3)})`);
        card.style.setProperty('--member-focus-border', `rgba(94, 135, 82, ${(0.12 + focus * 0.48).toFixed(3)})`);
        card.style.zIndex = focus > 0.05 ? '2' : '0';
    });
    scheduleMemberRollFocus();
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden && memberRollAnimationFrame) {
        cancelAnimationFrame(memberRollAnimationFrame);
        memberRollAnimationFrame = 0;
    } else {
        scheduleMemberRollFocus();
    }
});

memberRollReducedMotion.addEventListener?.('change', () => {
    if (memberRollReducedMotion.matches && memberRollAnimationFrame) {
        cancelAnimationFrame(memberRollAnimationFrame);
        memberRollAnimationFrame = 0;
    } else {
        scheduleMemberRollFocus();
    }
});

function toggleMemberAutoScroll(button) {
    const container = document.getElementById('membersList');
    if (!container) return;
    const isPaused = container.classList.toggle('is-paused');
    if (isPaused && memberRollAnimationFrame) {
        cancelAnimationFrame(memberRollAnimationFrame);
        memberRollAnimationFrame = 0;
    } else {
        scheduleMemberRollFocus();
    }
    button.setAttribute('aria-pressed', String(isPaused));
    button.setAttribute('aria-label', isPaused ? 'Resume member auto-scroll' : 'Pause member auto-scroll');
    button.textContent = isPaused ? 'Resume' : 'Pause';
}

async function loadMemberPhoto(email) {
    try {
        const res = await callAPI('getProfileImage', { email });
        if (res.success && res.image) {
            memberPhotoCache[email.toLowerCase()] = res.image;
            document.querySelectorAll('#membersList .member-avatar').forEach(avatarEl => {
                if (avatarEl.dataset.memberEmail?.toLowerCase() === email.toLowerCase()) {
                    avatarEl.innerHTML = `<img src="${res.image}" alt="${escapeHtml(email)}">`;
                }
            });
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
                <span class="profile-role ${isTreas ? 'treasurer' : ''}">${isTreas ? 'Treasurer' : 'Member'}</span>
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
    if (membersEl) animateCountUp(membersEl, allMembersData.length, '');
    if (txnsEl) animateCountUp(txnsEl, allRecords.length, '');
    if (savingsEl) {
        const totalSaved = allRecords.filter(r => r.type === 'Savings').reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
        animateCountUp(savingsEl, totalSaved);
    }
}

// ============================================================
// HISTORY MODAL
// ============================================================
let currentHistoryRecords = [];
let currentHistorySort = { column: 'date', direction: 'desc' };

function openHistoryModal() {
    document.querySelector('.history-modal')?.remove();
    const modal = document.createElement('div');
    modal.className = 'history-modal';
    modal.setAttribute('role', 'presentation');
    modal.innerHTML = `
        <section class="history-modal-content" role="dialog" aria-modal="true" aria-labelledby="historyModalTitle" tabindex="-1">
            <div class="history-modal-header">
                <div>
                    <span class="history-modal-kicker">GROUP FINANCES</span>
                    <h3 id="historyModalTitle">Transaction history</h3>
                    <p>Browse deposits, loan activity, and repayments.</p>
                </div>
                <button type="button" class="close-history-btn" aria-label="Close transaction history" onclick="this.closest('.history-modal').remove()">✕</button>
            </div>
            <div class="history-modal-body">
                <div class="history-search">
                    <input type="search" id="historySearch" placeholder="Search members or notes" aria-label="Search members or notes">
                    <select id="historyFilterMember"><option value="">All Members</option>${allMembers.map(m => `<option value="${m}">${m}</option>`).join('')}</select>
                    <select id="historyFilterType"><option value="">All Types</option><option value="Savings">Savings</option><option value="Loan Taken">Loan Taken</option><option value="Loan Repayment">Loan Repayment</option></select>
                </div>
                <div class="history-table-wrap">
                    <table class="history-table">
                        <thead><tr><th><button type="button" onclick="sortHistory('date')">Date <span aria-hidden="true">↕</span></button></th><th><button type="button" onclick="sortHistory('member')">Member <span aria-hidden="true">↕</span></button></th><th><button type="button" onclick="sortHistory('type')">Type <span aria-hidden="true">↕</span></button></th><th><button type="button" onclick="sortHistory('amount')">Amount <span aria-hidden="true">↕</span></button></th><th>Note</th><th></th></tr></thead>
                        <tbody id="historyBody"></tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
    modal.addEventListener('click', event => {
        if (event.target === modal) modal.remove();
    });
    modal.tabIndex = -1;
    modal.addEventListener('keydown', event => {
        if (event.key === 'Escape') modal.remove();
    });
    document.body.appendChild(modal);
    currentHistoryRecords = [...allRecords];
    currentHistorySort = { column: 'date', direction: 'desc' };
    renderHistoryTable();
    document.getElementById('historySearch')?.addEventListener('input', filterHistory);
    document.getElementById('historyFilterMember')?.addEventListener('change', filterHistory);
    document.getElementById('historyFilterType')?.addEventListener('change', filterHistory);
    modal.querySelector('.history-modal-content')?.focus({ preventScroll: true });
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

function sortHistory(column) {
    if (currentHistorySort.column === column) {
        currentHistorySort.direction = currentHistorySort.direction === 'asc' ? 'desc' : 'asc';
    } else {
        currentHistorySort = { column, direction: column === 'date' || column === 'amount' ? 'desc' : 'asc' };
    }
    filterHistory();
}

// ============================================================
// TOGGLE READ MORE FUNCTION - FIXED
// ============================================================
function toggleReadMore(id, full, truncated) {
    const el = document.getElementById(id);
    if (!el) return;
    const btn = el.nextElementSibling;
    if (!btn) return;
    
    if (el.classList.contains('truncated')) {
        el.classList.remove('truncated');
        el.innerHTML = full;
        btn.innerHTML = 'Read less';
    } else {
        el.classList.add('truncated');
        el.innerHTML = truncated;
        btn.innerHTML = 'Read more';
    }
}

function renderHistoryTable(filtered = null) {
    const tbody = document.getElementById('historyBody');
    if (!tbody) return;
    const records = [...(filtered || currentHistoryRecords)].sort((a, b) => {
        const { column, direction } = currentHistorySort;
        const multiplier = direction === 'asc' ? 1 : -1;
        if (column === 'date') return multiplier * (new Date(a.date).getTime() - new Date(b.date).getTime());
        if (column === 'amount') return multiplier * (Number(a.amount || 0) - Number(b.amount || 0));
        return multiplier * String(a[column] || '').localeCompare(String(b[column] || ''), undefined, { sensitivity: 'base' });
    });
    if (!records.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No transactions found</td></tr>'; return; }
    tbody.innerHTML = records.map(r => {
        let cls = r.type === 'Savings' ? 'badge-savings' : (r.type === 'Loan Taken' ? 'badge-loan' : 'badge-repayment');
        let sign = r.type === 'Loan Repayment' ? '+' : (r.type === 'Savings' ? '+' : '-');
        let msg = r.message || '-';
        const rowKey = `${r.date}|${r.member}|${r.type}|${r.amount}`;
        const isOwn = r.member === currentUser;
        const editBtn = isOwn ? `<button class="edit-txn-btn" onclick="openEditTransactionModal(${JSON.stringify(rowKey)}, ${JSON.stringify(r.type)}, ${r.amount}, ${JSON.stringify(r.message || '')})"> Edit</button>` : '';
        return `<tr>
            <td data-label="Date">${new Date(r.date).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
            <td data-label="Member"><strong>${escapeHtml(r.member)}</strong></td>
            <td data-label="Type"><span class="badge ${cls}">${escapeHtml(r.type)}</span></td>
            <td data-label="Amount" class="history-amount ${sign === '-' ? 'negative' : 'positive'}">${sign} KES ${(r.amount || 0).toLocaleString('en-KE')}</td>
            <td data-label="Note" class="message-cell">${escapeHtml(msg)}</td>
            <td data-label="Actions" class="history-actions">${editBtn}</td>
        </tr>`;
    }).join('');
}

function openEditTransactionModal(rowKey, type, currentAmount, currentMessage) {
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <div class="modal-content">
            <h3> Request Edit</h3>
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
const PHONE_COUNTRIES = [
    { code: 'KE', name: 'Kenya', dialCode: '+254' },
    { code: 'UG', name: 'Uganda', dialCode: '+256' },
    { code: 'TZ', name: 'Tanzania', dialCode: '+255' },
    { code: 'RW', name: 'Rwanda', dialCode: '+250' },
    { code: 'ET', name: 'Ethiopia', dialCode: '+251' },
    { code: 'SS', name: 'South Sudan', dialCode: '+211' },
    { code: 'US', name: 'United States', dialCode: '+1' },
    { code: 'GB', name: 'United Kingdom', dialCode: '+44' },
    { code: 'CA', name: 'Canada', dialCode: '+1' },
    { code: 'AE', name: 'United Arab Emirates', dialCode: '+971' }
];

function countryFlag(countryCode) {
    if (!/^[A-Z]{2}$/i.test(countryCode || '')) return '';
    return [...countryCode.toUpperCase()].map(char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('');
}

function renderProfilePhone(phone, country, dialCode, verifiedAt) {
    if (!phone) return '<span class="profile-phone-empty">No phone number added yet. Ask an administrator to add one.</span>';
    const flag = countryFlag(country);
    return `<div class="profile-phone-line">
        <span class="profile-phone-number">${escapeHtml(phone)}</span>
        <span class="profile-phone-country">${flag ? `<span>${flag}</span>` : ''}${escapeHtml(dialCode || '')}</span>
        ${verifiedAt ? '<span class="admin-verified-pill">Verified by admin <span aria-hidden="true">✓</span></span>' : '<span class="profile-phone-pending">Awaiting admin confirmation</span>'}
    </div>`;
}

function openProfileModal() {
    document.querySelectorAll('.profile-modal-overlay').forEach(el => el.remove());
    const userStats = getUserStats(currentUser);
    const initial = (currentUserDisplayName || currentUser) ? getInitials(currentUserDisplayName || currentUser) : '?';
    const profileImage = getProfileImage();
    const isTreas = isTreasurer();
    const isDev = isDeveloper();
    const roleLabel = isDev ? 'Developer' : currentUserRole === 'admin' ? 'Administrator' : isTreas ? 'Treasurer' : 'Member';
    const overlay = document.createElement('div');
    overlay.className = 'profile-modal-overlay';
    overlay.onclick = function(e) { if (e.target === this) this.remove(); };
    overlay.innerHTML = `
        <div class="profile-modal">
            <div class="profile-cover">
                <div class="profile-avatar-wrapper">
                    <div class="profile-avatar" id="profileAvatar" onclick="document.getElementById('profileFileInput').click()">
                        ${profileImage ? `<img src="${escapeHtml(profileImage)}" alt="${escapeHtml(currentUserDisplayName || currentUser)}">` : initial}
                        <div class="avatar-overlay"><span class="camera-icon"></span><span>Change Photo</span></div>
                    </div>
                    <button type="button" class="profile-photo-edit" onclick="document.getElementById('profileFileInput').click()">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
                        <span>Edit photo</span>
                    </button>
                </div>
            </div>
            <div class="profile-body">
                <div class="profile-name" id="profileDisplayName">${escapeHtml(currentUserDisplayName || currentUser)}</div>
                <div class="profile-email">${escapeHtml(currentUserEmail)} <span class="profile-google-managed">Google account</span></div>
                <span class="profile-role ${isTreas ? 'treasurer' : ''} ${isDev ? 'developer' : ''} ${currentUserRole === 'admin' ? 'administrator' : ''}">${roleLabel}</span>
                <div class="profile-edit-fields">
                    <label for="profileNameInput">Full name</label>
                    <input id="profileNameInput" type="text" maxlength="80" value="${escapeHtml(currentUserDisplayName || currentUser)}" autocomplete="name">
                    <label>Phone number <span class="profile-field-note">managed by an administrator</span></label>
                    <div id="profilePhoneDisplay">${renderProfilePhone(currentUserPhone, currentUserPhoneCountry, currentUserPhoneDialCode, currentUserPhoneVerifiedAt)}</div>
                    <p class="profile-verification-note">A phone is marked as verified when an approved administrator adds it to your group profile.</p>
                    <button type="button" class="profile-save-btn" onclick="saveOwnProfile()">Save profile</button>
                </div>
                <div class="profile-divider"></div>
                <div class="profile-stats-grid">
                    <div class="profile-stat-card savings"><div class="stat-number">KES ${userStats.savings.toLocaleString()}</div><div class="stat-label">Total Savings</div></div>
                    <div class="profile-stat-card loans"><div class="stat-number">KES ${userStats.loans.toLocaleString()}</div><div class="stat-label">Total Loans</div></div>
                    <div class="profile-stat-card repaid"><div class="stat-number">KES ${userStats.repaid.toLocaleString()}</div><div class="stat-label">Total Repaid</div></div>
                    <div class="profile-stat-card net"><div class="stat-number">KES ${userStats.net.toLocaleString()}</div><div class="stat-label">Net Balance</div></div>
                </div>
                <div class="profile-divider"></div>
                <div class="profile-actions">
                    <button class="btn-close" onclick="this.closest('.profile-modal-overlay').remove()">Close</button>
                </div>
                <div class="upload-progress" id="uploadProgress"><span id="uploadStatus">Uploading...</span><div class="progress-bar"><div class="progress-fill" id="uploadProgressFill"></div></div></div>
            </div>
            <input type="file" id="profileFileInput" class="profile-file-input" accept="image/jpeg,image/png,image/webp" onchange="handleProfileImageUpload(event)">
        </div>
    `;
    document.body.appendChild(overlay);
}

async function saveOwnProfile() {
    const input = document.getElementById('profileNameInput');
    const button = document.querySelector('.profile-save-btn');
    const name = input?.value.trim() || '';
    if (name.length < 2 || name.length > 80) {
        showToast('Enter a name between 2 and 80 characters.', 'error');
        input?.focus();
        return;
    }
    if (button) button.disabled = true;
    try {
        const result = await callAPI('updateOwnProfile', { displayName: name });
        if (!result.success) throw new Error(result.error || 'Could not update your profile.');
        currentUserDisplayName = result.displayName;
        const userLabel = document.getElementById('loggedInUser');
        if (userLabel) userLabel.textContent = currentUserDisplayName;
        const displayName = document.getElementById('profileDisplayName');
        if (displayName) displayName.textContent = currentUserDisplayName;
        updateHeaderAvatar();
        updateDashboardGreeting();
        showToast('Profile updated.', 'success');
    } catch (error) {
        showToast(error.message || 'Could not update your profile.', 'error');
    } finally {
        if (button) button.disabled = false;
    }
}

async function loadAdminMemberProfiles(containerId) {
    const container = document.getElementById(containerId);
    if (!container || !hasAdminPortalAccess()) return;
    container.innerHTML = '<div class="loading-container"><div class="loading-spinner"></div><div>Loading member contacts...</div></div>';
    try {
        const result = await callAPI('getAdminMemberProfiles');
        if (!result.success) throw new Error(result.error || 'Could not load member contacts.');
        if (!result.profiles.length) {
            container.innerHTML = '<div class="empty-state">No approved members found.</div>';
            return;
        }
        container.className = 'admin-phone-profiles';
        container.innerHTML = result.profiles.map(profile => {
            const selectedCountry = PHONE_COUNTRIES.find(country => country.code === profile.phoneCountry) || PHONE_COUNTRIES[0];
            const nationalNumber = profile.phone && profile.phoneDialCode && profile.phone.startsWith(profile.phoneDialCode)
                ? profile.phone.slice(profile.phoneDialCode.length)
                : profile.phone.replace(/^\+/, '');
            const countryOptions = PHONE_COUNTRIES.map(country =>
                `<option value="${country.code}" data-dial-code="${country.dialCode}" ${selectedCountry.code === country.code ? 'selected' : ''}>${countryFlag(country.code)} ${country.name} (${country.dialCode})</option>`
            ).join('');
            return `<article class="admin-phone-row" data-email="${escapeHtml(profile.email)}" data-has-phone="${Boolean(profile.phone)}">
                <div class="admin-phone-member">
                    <strong>${escapeHtml(profile.name || 'Member')}</strong>
                    <span>${escapeHtml(profile.email)}</span>
                    ${profile.phone
                        ? `<span class="admin-verified-pill">${countryFlag(profile.phoneCountry)} ${escapeHtml(profile.phone)} · Verified by admin</span>`
                        : '<span class="profile-phone-pending">No phone number on file</span>'}
                </div>
                <details class="admin-phone-editor">
                    <summary>${profile.phone ? 'Edit verified number' : 'Add phone number'}</summary>
                    <div class="admin-phone-editor-fields">
                    <label>
                        <span>Country / calling code</span>
                        <select class="admin-phone-country">${countryOptions}</select>
                    </label>
                    <label>
                        <span>Phone number</span>
                        <input class="admin-phone-input" type="tel" inputmode="tel" autocomplete="tel-national" value="${escapeHtml(nationalNumber)}" placeholder="712 345 678">
                    </label>
                    <button type="button" class="admin-phone-save" onclick="saveMemberPhone(this)">Save &amp; verify</button>
                    <span class="admin-phone-status" role="status"></span>
                    </div>
                </details>
            </article>`;
        }).join('');
    } catch (error) {
        container.className = 'admin-phone-profiles';
        container.innerHTML = `<div class="empty-state">${escapeHtml(error.message || 'Could not load member contacts.')}</div>`;
    }
}

async function saveMemberPhone(button) {
    if (!hasAdminPortalAccess()) {
        showToast('Only approved administrators can manage member phone numbers.', 'error');
        return;
    }
    const row = button?.closest('.admin-phone-row');
    if (!row) return;
    const email = row.dataset.email;
    const countrySelect = row.querySelector('.admin-phone-country');
    const phoneInput = row.querySelector('.admin-phone-input');
    const status = row.querySelector('.admin-phone-status');
    const country = PHONE_COUNTRIES.find(item => item.code === countrySelect.value);
    const digits = phoneInput.value.replace(/\D/g, '').replace(/^0+/, '');
    let phone = '';
    if (digits) {
        const nationalDigits = country && digits.startsWith(country.dialCode.slice(1))
            ? digits.slice(country.dialCode.length - 1)
            : digits;
        if (!country || nationalDigits.length < 6 || nationalDigits.length > 12) {
            status.textContent = 'Enter a valid national phone number.';
            phoneInput.focus();
            return;
        }
        phone = `${country.dialCode}${nationalDigits}`;
    } else {
        if (!row.dataset.hasPhone) {
            status.textContent = 'Enter a phone number to save.';
            phoneInput.focus();
            return;
        }
        if (!confirm('Remove this member’s phone number and admin verification?')) return;
    }
    button.disabled = true;
    status.textContent = 'Saving...';
    try {
        const result = await callAPI('setMemberPhone', {
            email,
            phone,
            country: country?.code || '',
            dialCode: country?.dialCode || ''
        });
        if (!result.success) throw new Error(result.error || 'Could not update this phone number.');
        if (email.toLowerCase() === (currentUserEmail || '').toLowerCase()) {
            currentUserPhone = result.phone || '';
            currentUserPhoneCountry = result.country || '';
            currentUserPhoneDialCode = result.dialCode || '';
            currentUserPhoneVerifiedAt = result.phoneVerifiedAt || '';
            currentUserPhoneVerifiedBy = result.phoneVerifiedBy || '';
            updateHeaderAvatar();
            const phoneDisplay = document.getElementById('profilePhoneDisplay');
            if (phoneDisplay) {
                phoneDisplay.innerHTML = renderProfilePhone(
                    currentUserPhone,
                    currentUserPhoneCountry,
                    currentUserPhoneDialCode,
                    currentUserPhoneVerifiedAt
                );
            }
        }
        status.textContent = 'Saved';
        showToast(phone ? 'Phone saved and marked verified by admin.' : 'Phone number removed.', 'success');
        await loadAdminMemberProfiles(row.closest('#developerPhoneProfiles') ? 'developerPhoneProfiles' : 'adminPhoneProfiles');
    } catch (error) {
        status.textContent = error.message || 'Could not save this phone number.';
        showToast(status.textContent, 'error');
    } finally {
        button.disabled = false;
    }
}

function getProfileImage() {
    return userProfileImage
        || localStorage.getItem(`legacy_profile_image_${(currentUserEmail || '').toLowerCase()}`)
        || (window.firebaseAuth && window.firebaseAuth.currentUser && window.firebaseAuth.currentUser.photoURL)
        || (DEVELOPMENT_PREVIEW_ENABLED ? DEVELOPMENT_PREVIEW_PROFILE_IMAGE : null);
}

const MAX_CLOUDINARY_IMAGE_SIZE = 5 * 1024 * 1024;
const ALLOWED_CLOUDINARY_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

async function uploadBlobToCloudinary(blob, filename, uploadPreset) {
    const config = window.cloudinaryConfig || {};
    const preset = uploadPreset || config.uploadPreset;
    if (!config.cloudName || !preset) throw new Error('Cloudinary upload preset is not configured.');
    if (!ALLOWED_CLOUDINARY_IMAGE_TYPES.has(blob.type)) throw new Error('Choose a JPG, PNG, or WebP image.');
    if (blob.size > MAX_CLOUDINARY_IMAGE_SIZE) throw new Error('Choose an image smaller than 5 MB.');

    const formData = new FormData();
    formData.append('file', blob, filename);
    formData.append('upload_preset', preset);
    let response;
    try {
        response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/upload`, {
            method: 'POST',
            body: formData
        });
    } catch (error) {
        throw new Error(`Could not reach Cloudinary: ${error.message}`);
    }
    let result;
    try {
        result = await response.json();
    } catch {
        throw new Error(`Cloudinary returned an invalid response (HTTP ${response.status}).`);
    }
    if (!response.ok || !result.secure_url || !result.public_id) {
        throw new Error(result.error?.message || `Cloudinary upload failed (HTTP ${response.status}).`);
    }
    return { image: result.secure_url, publicId: result.public_id };
}

function openImageCropper(file, mode) {
    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();
        const overlay = document.createElement('div');
        overlay.className = 'image-crop-overlay';
        overlay.innerHTML = `<section class="image-crop-dialog" role="dialog" aria-modal="true" aria-labelledby="imageCropTitle">
            <header class="image-crop-heading"><div><span class="section-kicker">${mode === 'profile' ? 'PROFILE PHOTO' : 'GROUP MEMORY'}</span><h2 id="imageCropTitle">Adjust your photo</h2><p>Drag to position the image, then use the slider to zoom.</p></div><button type="button" class="image-crop-close" data-crop-cancel aria-label="Cancel crop">&times;</button></header>
            ${mode === 'memory' ? '<label class="image-crop-ratio-label" for="imageCropRatio">Photo shape<select id="imageCropRatio"><option value="1.333333" selected>Landscape</option><option value="original">Original</option><option value="1">Square</option><option value="1.777778">Wide</option></select></label>' : ''}
            <div class="image-crop-stage" id="imageCropStage"><img class="image-crop-image" alt="Photo crop preview"></div>
            <label class="image-crop-zoom" for="imageCropZoom"><span>Zoom</span><input type="range" id="imageCropZoom" min="1" max="3" step="0.01" value="1"><span>+</span></label>
            <div class="image-crop-actions"><button type="button" class="image-crop-cancel" data-crop-cancel>Cancel</button><button type="button" class="image-crop-confirm" id="imageCropConfirm">Use this crop</button></div>
            <p class="image-crop-error" role="status"></p>
        </section>`;
        document.body.appendChild(overlay);
        const stage = overlay.querySelector('#imageCropStage');
        const preview = overlay.querySelector('.image-crop-image');
        const zoomInput = overlay.querySelector('#imageCropZoom');
        const ratioInput = overlay.querySelector('#imageCropRatio');
        const confirmButton = overlay.querySelector('#imageCropConfirm');
        const errorMessage = overlay.querySelector('.image-crop-error');
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        let frameWidth = 0, frameHeight = 0, baseScale = 1, zoom = 1, offsetX = 0, offsetY = 0;
        let aspectRatio = mode === 'profile' ? 1 : 1.333333;
        let pointerId = null, dragX = 0, dragY = 0, originX = 0, originY = 0, settled = false;

        const cleanup = () => {
            document.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('resize', layoutCrop);
            URL.revokeObjectURL(objectUrl);
            overlay.remove();
            document.body.style.overflow = previousOverflow;
        };
        const finish = (blob, error) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(blob);
        };
        const clampOffsets = () => {
            const width = image.naturalWidth * baseScale * zoom;
            const height = image.naturalHeight * baseScale * zoom;
            const horizontalLimit = Math.max(0, (width - frameWidth) / 2);
            const verticalLimit = Math.max(0, (height - frameHeight) / 2);
            offsetX = Math.max(-horizontalLimit, Math.min(horizontalLimit, offsetX));
            offsetY = Math.max(-verticalLimit, Math.min(verticalLimit, offsetY));
        };
        const renderCrop = () => {
            const width = image.naturalWidth * baseScale * zoom;
            const height = image.naturalHeight * baseScale * zoom;
            preview.style.width = `${width}px`;
            preview.style.height = `${height}px`;
            preview.style.left = `${(frameWidth - width) / 2 + offsetX}px`;
            preview.style.top = `${(frameHeight - height) / 2 + offsetY}px`;
        };
        const layoutCrop = () => {
            const parentStyle = getComputedStyle(stage.parentElement);
            const availableWidth = stage.parentElement.clientWidth
                - parseFloat(parentStyle.paddingLeft)
                - parseFloat(parentStyle.paddingRight);
            const availableHeight = Math.max(180, window.innerHeight * 0.44);
            const targetWidth = Math.min(availableWidth, availableHeight * aspectRatio);
            stage.style.width = `${targetWidth}px`;
            stage.style.height = `${targetWidth / aspectRatio}px`;
            frameWidth = stage.clientWidth;
            frameHeight = stage.clientHeight;
            baseScale = Math.max(frameWidth / image.naturalWidth, frameHeight / image.naturalHeight);
            clampOffsets();
            renderCrop();
        };
        const onKeyDown = event => {
            if (event.key === 'Escape') finish(null, new DOMException('Photo crop canceled.', 'AbortError'));
        };
        image.onload = () => {
            aspectRatio = mode === 'profile' ? 1 : 1.333333;
            preview.src = objectUrl;
            layoutCrop();
            document.addEventListener('keydown', onKeyDown);
            window.addEventListener('resize', layoutCrop);
            overlay.querySelectorAll('[data-crop-cancel]').forEach(button => {
                button.addEventListener('click', () => finish(null, new DOMException('Photo crop canceled.', 'AbortError')));
            });
            zoomInput.addEventListener('input', () => {
                zoom = Number(zoomInput.value);
                clampOffsets();
                renderCrop();
            });
            ratioInput?.addEventListener('change', () => {
                aspectRatio = ratioInput.value === 'original'
                    ? image.naturalWidth / image.naturalHeight
                    : Number(ratioInput.value);
                offsetX = 0;
                offsetY = 0;
                layoutCrop();
            });
            stage.addEventListener('pointerdown', event => {
                pointerId = event.pointerId;
                dragX = event.clientX;
                dragY = event.clientY;
                originX = offsetX;
                originY = offsetY;
                stage.setPointerCapture(pointerId);
            });
            stage.addEventListener('pointermove', event => {
                if (event.pointerId !== pointerId) return;
                offsetX = originX + event.clientX - dragX;
                offsetY = originY + event.clientY - dragY;
                clampOffsets();
                renderCrop();
            });
            stage.addEventListener('pointerup', event => {
                if (event.pointerId === pointerId) pointerId = null;
            });
            stage.addEventListener('pointercancel', () => { pointerId = null; });
            confirmButton.addEventListener('click', () => {
                confirmButton.disabled = true;
                const scale = baseScale * zoom;
                const sourceX = Math.max(0, ((frameWidth - image.naturalWidth * scale) / 2 + offsetX) * -1 / scale);
                const sourceY = Math.max(0, ((frameHeight - image.naturalHeight * scale) / 2 + offsetY) * -1 / scale);
                const sourceWidth = Math.min(image.naturalWidth - sourceX, frameWidth / scale);
                const sourceHeight = Math.min(image.naturalHeight - sourceY, frameHeight / scale);
                const outputWidth = Math.max(1, Math.round(Math.min(1600, sourceWidth)));
                const outputHeight = Math.max(1, Math.round(outputWidth / aspectRatio));
                const canvas = document.createElement('canvas');
                canvas.width = outputWidth;
                canvas.height = outputHeight;
                const context = canvas.getContext('2d');
                if (!context) {
                    errorMessage.textContent = 'Your browser could not prepare this crop.';
                    confirmButton.disabled = false;
                    return;
                }
                context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, outputWidth, outputHeight);
                canvas.toBlob(blob => {
                    if (!blob) {
                        errorMessage.textContent = 'Could not prepare this photo. Please try again.';
                        confirmButton.disabled = false;
                        return;
                    }
                    finish(blob);
                }, 'image/jpeg', 0.94);
            });
            confirmButton.focus();
        };
        image.onerror = () => finish(null, new Error('Could not open this photo. Please choose a JPG, PNG, or WebP image.'));
        image.src = objectUrl;
    });
}

async function saveProfileImageToServer(imageData) {
    const blob = imageData instanceof Blob ? imageData : await (await fetch(imageData)).blob();
    const uploaded = await uploadBlobToCloudinary(blob, 'profile.jpg');
    const res = await callAPI('saveProfileImage', {
        email: currentUserEmail,
        image: uploaded.image,
        publicId: uploaded.publicId
    });
    if (!res.success) throw new Error(res.error || 'Failed to save profile photo.');
    userProfileImage = uploaded.image;
    localStorage.setItem(`legacy_profile_image_${currentUserEmail.toLowerCase()}`, userProfileImage);
    updateHeaderAvatar();
    loadMembersList();
    return true;
}

async function handleProfileImageUpload(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    if (!file) return;
    const progressEl = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('uploadProgressFill');
    const statusEl = document.getElementById('uploadStatus');
    if (!ALLOWED_CLOUDINARY_IMAGE_TYPES.has(file.type)) {
        showToast('Choose a JPG, PNG, or WebP photo.', 'error');
        input.value = '';
        return;
    }
    if (file.size > 10 * 1024 * 1024) {
        showToast('Choose a photo smaller than 10 MB.', 'error');
        input.value = '';
        return;
    }
    progressEl.classList.add('active');
    progressFill.style.width = '0%';
    statusEl.textContent = 'Adjust your crop...';
    try {
        const photoBlob = await openImageCropper(file, 'profile');
        statusEl.textContent = 'Uploading photo...';
        progressFill.style.width = '45%';
        await saveProfileImageToServer(photoBlob);
        const avatar = document.getElementById('profileAvatar');
        if (avatar) {
            avatar.innerHTML = `<img src="${escapeHtml(getProfileImage())}" alt="${escapeHtml(currentUserDisplayName || currentUser)}"><div class="avatar-overlay"><span class="camera-icon"></span><span>Change Photo</span></div>`;
        }
        progressFill.style.width = '100%';
        statusEl.textContent = 'Profile photo updated.';
        showToast('Profile photo updated.', 'success');
        setTimeout(() => {
            progressEl.classList.remove('active');
            progressFill.style.width = '0%';
        }, 1500);
    } catch (error) {
        if (error.name === 'AbortError') {
            statusEl.textContent = 'Photo update canceled.';
            progressEl.classList.remove('active');
            return;
        }
        statusEl.textContent = error.message || 'Could not save this photo.';
        progressFill.style.width = '0%';
        showToast(statusEl.textContent, 'error');
    } finally {
        input.value = '';
    }
}

// ============================================================
// CHANGE PASSWORD
// ============================================================
function openChangePasswordModal() {
    showToast('Password settings for Google sign-in are managed by Google.', 'info');
}

async function changePassword() {
    openChangePasswordModal();
}

// ============================================================
// CHART
// ============================================================
let chartRevealFrame = null;

function renderChart(summary) {
    const canvas = document.getElementById('financialChart');
    if (!canvas) return;
    const savings = Number(summary.savings) || 0;
    const contributionTarget = 2500 * 4 * 9;
    const remainingTarget = Math.max(0, contributionTarget - savings);
    const outstanding = Number(summary.outstanding);
    const contributed = Math.min(savings, contributionTarget);
    const progress = contributionTarget > 0 ? Math.min(100, (contributed / contributionTarget) * 100) : 0;

    const chartContributed = document.getElementById('summaryChartContributed');
    const chartRemaining = document.getElementById('summaryChartRemaining');
    const chartTarget = document.getElementById('summaryChartTarget');
    const chartProgressFill = document.getElementById('summaryChartProgressFill');
    const chartProgressNote = document.getElementById('summaryChartProgressNote');
    animateCountUp(chartContributed, contributed);
    animateCountUp(chartRemaining, remainingTarget);
    animateCountUp(chartTarget, contributionTarget);
    if (chartProgressFill) chartProgressFill.style.width = `${progress}%`;
    if (chartProgressNote) chartProgressNote.textContent = `Savings growth from April · ${progress.toFixed(0)}% of the year-end goal reached.`;

    animateCountUp(document.getElementById('summaryStatAvailable'), savings);
    animateCountUp(document.getElementById('summaryStatOutstanding'), summary.outstanding || 0);
    animateCountUp(document.getElementById('summaryStatInterest'), summary.interestEarned || 0);

    if (chartRevealFrame) {
        cancelAnimationFrame(chartRevealFrame);
        chartRevealFrame = null;
    }
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
    const ctx = canvas.getContext('2d');
    const now = new Date();
    const startMonth = new Date(now.getFullYear(), 3, 1);
    const monthCount = Math.max(1, now.getMonth() - startMonth.getMonth() + 1);
    const months = Array.from({ length: monthCount }, (_, index) => new Date(now.getFullYear(), 3 + index, 1));
    const monthlySavings = months.map(month => {
        const key = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`;
        return allRecords.reduce((total, record) => {
            const recordDate = String(record.date || '');
            return total + (record.type === 'Savings' && recordDate.startsWith(key) ? Number(record.amount) || 0 : 0);
        }, 0);
    });
    let runningSavings = 0;
    const savingsTrend = monthlySavings.map(amount => (runningSavings += amount));
    if (savingsTrend.length && savings > savingsTrend[savingsTrend.length - 1]) savingsTrend[savingsTrend.length - 1] = savings;
    const targetTrend = months.map((_, index) => Math.min(contributionTarget, (index + 1) * 2500 * 4));
    const labels = months.map(month => month.toLocaleDateString('en-KE', { month: 'short' }));
    const savingsGradient = ctx.createLinearGradient(0, 0, 0, 280);
    savingsGradient.addColorStop(0, 'rgba(54, 116, 84, .32)');
    savingsGradient.addColorStop(1, 'rgba(54, 116, 84, .015)');

    const chartRevealPlugin = {
        id: 'summaryLineReveal',
        beforeDatasetsDraw(chart) {
            if (!chart.chartArea) return;
            const progress = Math.max(0, Math.min(1, Number(chart.$summaryRevealProgress) || 0));
            const { left, top, right, bottom } = chart.chartArea;
            const context = chart.ctx;
            context.save();
            context.beginPath();
            context.rect(left, top, Math.max(1, (right - left) * progress), bottom - top);
            context.clip();
            chart.$summaryRevealContext = context;
        },
        afterDatasetsDraw(chart) {
            chart.$summaryRevealContext?.restore();
            chart.$summaryRevealContext = null;
        }
    };

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Savings', data: savingsTrend, borderColor: '#367454', backgroundColor: savingsGradient,
                fill: true, borderWidth: 3, tension: .38, pointRadius: 4, pointHoverRadius: 7,
                pointBackgroundColor: '#fff', pointBorderColor: '#367454', pointBorderWidth: 2
            }, {
                label: 'Contribution pace', data: targetTrend, borderColor: '#8DA9D8', borderDash: [6, 5],
                borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: .2, fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: { usePointStyle: true, pointStyle: 'line', boxWidth: 18, padding: 16, font: { family: '"DM Sans", sans-serif', size: window.innerWidth < 500 ? 10 : 11, weight: '700' }, color: '#6D8173' }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            return `${context.dataset.label}: KES ${Math.round(context.parsed.y).toLocaleString('en-KE')}`;
                        }
                    }
                }
            },
            scales: {
                x: { grid: { display: false }, ticks: { color: '#84958A', font: { family: '"DM Sans", sans-serif', size: 10, weight: '700' } } },
                y: { beginAtZero: true, grid: { color: 'rgba(123, 151, 130, .13)' }, ticks: { color: '#84958A', padding: 8, callback: value => `KES ${Number(value).toLocaleString('en-KE')}`, font: { family: '"DM Sans", sans-serif', size: 9 } } }
            },
            animation: false,
            interaction: { intersect: false, mode: 'index' },
            layout: { padding: { top: 10, right: 12, bottom: 4, left: 2 } }
        },
        plugins: [chartRevealPlugin]
    });

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const revealDuration = reducedMotion ? 0 : 1250;
    const revealStartedAt = performance.now();
    const revealChart = timestamp => {
        if (!chartInstance) return;
        const elapsed = timestamp - revealStartedAt;
        const rawProgress = revealDuration ? Math.min(1, elapsed / revealDuration) : 1;
        const easedProgress = 1 - Math.pow(1 - rawProgress, 3);
        chartInstance.$summaryRevealProgress = easedProgress;
        chartInstance.draw();
        if (rawProgress < 1) chartRevealFrame = requestAnimationFrame(revealChart);
        else chartRevealFrame = null;
    };
    chartInstance.$summaryRevealProgress = 0;
    chartInstance.draw();
    chartRevealFrame = requestAnimationFrame(revealChart);
}

// ============================================================
// EXPORT FUNCTIONS
// ============================================================
function exportToCSV() {
    const btn = document.getElementById('exportCsvBtn');
    const originalButtonContent = btn?.innerHTML;
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing download...'; }
    try {
        const columns = ['Date', 'Member', 'Type', 'Amount (KES)', 'Message', 'Group balance after'];
        let runningBalance = 0;
        const rows = [...allRecords].sort((a, b) => new Date(a.date) - new Date(b.date)).map(r => {
            const amount = Number(r.amount) || 0;
            if (r.type === 'Savings' || r.type === 'Loan Repayment') runningBalance += amount;
            if (r.type === 'Loan Taken') runningBalance -= amount;
            return [r.date || '', r.member || '', r.type || '', amount, r.message || '', runningBalance];
        });
        const escapeCell = (val) => {
            const str = String(val);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) return `"${str.replace(/"/g, '""')}"`;
            return str;
        };
        const csvLines = [
            'NBFA GROUP — Transaction Export',
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
        a.download = `NBFA_GROUP_Transactions_${new Date().toISOString().split('T')[0]}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`Exported ${rows.length} transactions`, 'success');
    } catch (error) {
        console.error('CSV export failed:', error);
        showToast('Could not create the CSV download. Please try again.', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalButtonContent;
        }
    }
}

function exportToPDF() {
    const exportBtn = document.getElementById('exportPdfBtn');
    if (typeof html2pdf !== 'function') {
        showToast('PDF export is unavailable. Check your connection and try again.', 'error');
        return;
    }
    if (!exportBtn) {
        console.error('PDF export button was not found.');
        showToast('Could not start the PDF export.', 'error');
        return;
    }
    const exportBtnOrig = exportBtn.innerHTML;
    showButtonLoading(exportBtn, 'Preparing PDF...');
    let savingsFromRecords = 0, loansFromRecords = 0, repaidFromRecords = 0;
    allRecords.forEach(r => {
        if (r.type === 'Savings') savingsFromRecords += Number(r.amount) || 0;
        else if (r.type === 'Loan Taken') loansFromRecords += Number(r.amount) || 0;
        else if (r.type === 'Loan Repayment') repaidFromRecords += Number(r.amount) || 0;
    });
    const summaryValue = (key, fallback) => {
        const value = Number(lastGroupSummary?.[key]);
        return Number.isFinite(value) ? value : fallback;
    };
    const savings = summaryValue('savings', savingsFromRecords);
    const loansTaken = summaryValue('loansTaken', loansFromRecords);
    const repaid = summaryValue('repaid', repaidFromRecords);
    const outstanding = summaryValue('outstanding', Math.max(0, loansTaken - repaid));
    const interestEarned = summaryValue('interestEarned', 0);
    const net = savings - outstanding;

    const generator = document.getElementById('pdfGenerator');
    const preview = document.getElementById('pdfPreview');
    if (!generator || !preview) {
        hideButtonLoading(exportBtn, exportBtnOrig);
        console.error('PDF preview container was not found.');
        showToast('Could not open the PDF preview.', 'error');
        return;
    }
    const recentRecords = [...allRecords]
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 10);
    const financialChartImg = chartInstance ? chartInstance.toBase64Image('image/png', 1) : null;
    const formatAmount = amount => `KES ${Number(amount || 0).toLocaleString('en-KE')}`;
    const transactionRows = recentRecords.length
        ? recentRecords.map(r => `<tr style="border-bottom:1px solid #E7EBF5;"><td style="padding:7px 8px;">${new Date(r.date).toLocaleDateString('en-KE')}</td><td style="padding:7px 8px;font-weight:500;">${escapeHtml(r.member)}</td><td style="padding:7px 8px;">${escapeHtml(r.type)}</td><td style="padding:7px 8px;text-align:right;">${r.type === 'Loan Taken' ? '-' : '+'} ${formatAmount(r.amount)}</td></tr>`).join('')
        : '<tr><td colspan="4" style="padding:16px;text-align:center;color:#7C8AA5;">No transactions have been recorded yet.</td></tr>';
    const metric = (label, value) => `<div style="padding:10px 8px;text-align:center;"><div style="font-size:9px;color:#718078;margin-bottom:4px;">${label}</div><div style="font-size:13px;font-weight:700;color:#18392F;">${formatAmount(value)}</div></div>`;
    generator.classList.add('active');
    preview.innerHTML = `
            <div id="pdfReportContent" style="max-width:800px;margin:0 auto;font-family:Arial,sans-serif;color:#18392F;font-size:12px;padding:10px;">
                <h1 style="margin:0;text-align:center;border-bottom:2px solid #367454;padding-bottom:9px;">NBFA GROUP</h1>
                <h2 style="margin:9px 0 3px;text-align:center;font-weight:500;font-size:17px;">Financial report</h2>
                <p style="margin:0;text-align:center;color:#718078;font-size:10px;">Prepared ${new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'long', day: 'numeric' })}</p>
                <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:1px;margin:18px 0;background:#E3EAE2;border:1px solid #E3EAE2;border-radius:8px;overflow:hidden;">
                    ${metric('Available balance', savings)}
                    ${metric('Outstanding principal', outstanding)}
                    ${metric('Interest earned', interestEarned)}
                    ${metric('Loans taken', loansTaken)}
                    ${metric('Repayments', repaid)}
                    ${metric('Net position', net)}
                </div>
                ${financialChartImg ? `<div style="margin:14px 0;padding:12px;border:1px solid #E3EAE2;border-radius:8px;text-align:center;"><h3 style="margin:0 0 8px;font-size:12px;">Financial activity breakdown</h3><img src="${financialChartImg}" style="display:block;max-width:100%;max-height:240px;margin:0 auto;" /></div>` : ''}
                <h3 style="margin:16px 0 6px;font-size:13px;">Recent transactions</h3>
                <table style="width:100%;border-collapse:collapse;font-size:10px;">
                    <thead><tr style="background:#EAF2E8;color:#254837;"><th style="padding:8px;text-align:left;">Date</th><th style="padding:8px;text-align:left;">Member</th><th style="padding:8px;text-align:left;">Type</th><th style="padding:8px;text-align:right;">Amount</th></tr></thead>
                    <tbody>${transactionRows}</tbody>
                </table>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:16px;padding:12px;background:#F4F7F2;border-radius:8px;">
                    <div style="text-align:center;"><div style="font-size:9px;color:#718078;">Group members</div><div style="font-size:13px;font-weight:700;">${allMembers.length}</div></div>
                    <div style="text-align:center;"><div style="font-size:9px;color:#718078;">Transactions</div><div style="font-size:13px;font-weight:700;">${allRecords.length}</div></div>
                </div>
                <p style="margin:16px 0 0;text-align:center;color:#718078;font-size:9px;border-top:1px solid #E3EAE2;padding-top:10px;">NBFA GROUP · Building wealth together</p>
                <button class="pdf-generate-btn" id="pdfGenerateBtn" data-html2canvas-ignore="true">Download PDF</button>
                <button class="pdf-close-btn" data-html2canvas-ignore="true" aria-label="Close PDF preview" onclick="document.getElementById('pdfGenerator').classList.remove('active', 'pdf-exporting')">×</button>
            </div>
        `;
    const generateButton = document.getElementById('pdfGenerateBtn');
    generateButton.addEventListener('click', async function() {
        const btn = this;
        btn.disabled = true;
        btn.textContent = 'Generating PDF...';
        generator.classList.add('pdf-exporting');
        const reportSource = document.getElementById('pdfReportContent');
        const options = {
            margin: 8,
            filename: `NBFA_GROUP_Report_${new Date().toISOString().split('T')[0]}.pdf`,
            image: { type: 'jpeg', quality: 0.95 },
            html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0 },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
            pagebreak: { mode: ['css', 'legacy'] }
        };
        try {
            await html2pdf().set(options).from(reportSource).save();
            generator.classList.remove('active', 'pdf-exporting');
            showToast('PDF downloaded!', 'success');
        } catch (error) {
            console.error('PDF export failed:', error);
            showToast('Could not create the PDF download. Please try again.', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Download PDF';
            generator.classList.remove('pdf-exporting');
        }
    });
    hideButtonLoading(exportBtn, exportBtnOrig);
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
            showToast('Notifications enabled!', 'success');
            document.getElementById('notificationPrompt').classList.remove('active');
            await registerServiceWorker();
            await subscribeToPush();
        } else {
            showToast('Notification permission denied', 'error');
        }
    } catch (e) { showToast('Error enabling notifications', 'error'); }
}

async function registerServiceWorker() {
    try {
        if ('serviceWorker' in navigator) {
            const registration = await navigator.serviceWorker.register('/service-worker.js');
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
        const res = await callAPI('savePushSubscription', { subscription: subscription.toJSON() });
        if (res.success) {
            pushSubscription = subscription;
            showToast('Push notifications enabled!', 'success');
        } else {
            showToast(res.error || 'Failed to save subscription', 'error');
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
    summary: 'Summary',
    loans: 'Loans',
    meetings: 'Meetings & inbox',
    pending: 'Admin Portal',
    about: 'About Us',
    developer: 'Developer Portal'
};

function ensureFullscreenBar(panel, tabId) {
    if (!panel.classList.contains('fullscreen-panel')) return;
    if (panel.querySelector('.fullscreen-panel-bar')) return;
    const bar = document.createElement('div');
    bar.className = 'fullscreen-panel-bar';
    const backButton = document.createElement('button');
    backButton.className = 'fullscreen-panel-back';
    backButton.type = 'button';
    backButton.setAttribute('aria-label', 'Back to Home');
    backButton.textContent = 'Home';
    backButton.addEventListener('click', () => activateTab('transactions'));

    const title = document.createElement('h2');
    title.textContent = PANEL_TITLES[tabId] || '';

    const user = document.createElement('button');
    user.className = 'fullscreen-panel-user';
    user.type = 'button';
    user.setAttribute('aria-label', 'Open your profile');
    user.addEventListener('click', openProfileModal);

    const avatar = document.createElement('span');
    avatar.className = 'fullscreen-panel-avatar';
    const name = document.createElement('span');
    name.className = 'fullscreen-panel-user-name';
    user.append(avatar, name);

    const logoutButton = document.createElement('button');
    logoutButton.className = 'fullscreen-panel-logout';
    logoutButton.type = 'button';
    logoutButton.setAttribute('aria-label', 'Log out');
    logoutButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg><span>Log out</span>';
    logoutButton.addEventListener('click', logout);

    bar.append(backButton, title, user, logoutButton);
    panel.insertBefore(bar, panel.firstChild);
    updateHeaderAvatar();
}

function activateTab(tabId) {
    if (tabId === 'groupChat') tabId = 'meetings';
    if (tabId === 'about') tabId = 'transactions';
    if (tabId !== 'meetings') toggleGroupChat(false);
    if (tabId === 'developer' && !isDeveloper()) {
        showToast('Developer portal access is restricted.', 'error');
        return;
    }
    if (tabId === 'pending' && !hasAdminPortalAccess()) {
        showToast('Admin portal access is restricted.', 'error');
        return;
    }
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
    if (tabId === 'loans') loadLoansDashboard();
    else if (tabId !== 'transactions' || !dashboardLoaded) loadAllData(false, true);
    if (tabId === 'meetings') {
        loadGroupMessages();
        markMeetingUpdatesRead();
    }
    if (tabId === 'pending') {
        loadAdminMemberProfiles('adminPhoneProfiles');
        loadAllUsersFull('adminAllUsersList');
    }
    if (tabId === 'developer') {
        loadAdminMemberProfiles('developerPhoneProfiles');
        if (typeof loadDeveloperPortal === 'function') loadDeveloperPortal();
    }
}

function initializeAppBackNavigation() {
    if (appBackNavigationInitialized || !currentUser) return;
    appBackNavigationInitialized = true;
    const addNavigationGuard = () => window.history.pushState({ appNavigationGuard: true }, document.title, window.location.href);
    addNavigationGuard();
    window.addEventListener('popstate', () => {
        if (!currentUser) return;
        if (currentTab !== 'transactions') {
            activateTab('transactions');
            addNavigationGuard();
            return;
        }
        showAppConfirmation({
            title: 'Leave NBFA GROUP?',
            message: 'You can come back any time. Are you sure you want to leave?',
            confirmLabel: 'Leave group',
            destructive: true
        }).then(confirmed => {
            if (!confirmed) addNavigationGuard();
        });
    });
}

let activeAppConfirmation = null;
function showAppConfirmation({ title, message, confirmLabel = 'Continue', destructive = false }) {
    if (activeAppConfirmation) return activeAppConfirmation.promise;
    const overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay';
    overlay.innerHTML = `<section class="app-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="appConfirmTitle" aria-describedby="appConfirmMessage" tabindex="-1">
        <div class="app-confirm-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M10 4.5h4M12 8v5m0 3.5h.01"/><path d="M10.3 3.8 2.8 17a2 2 0 0 0 1.8 3h14.8a2 2 0 0 0 1.8-3l-7.4-13.2a2 2 0 0 0-3.5 0Z"/></svg></div>
        <h2 id="appConfirmTitle">${escapeHtml(title)}</h2>
        <p id="appConfirmMessage">${escapeHtml(message)}</p>
        <div class="app-confirm-actions"><button type="button" class="app-confirm-cancel">Stay here</button><button type="button" class="app-confirm-accept${destructive ? ' is-destructive' : ''}">${escapeHtml(confirmLabel)}</button></div>
    </section>`;
    document.body.appendChild(overlay);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    let resolveConfirmation;
    const promise = new Promise(resolve => { resolveConfirmation = resolve; });
    const finish = confirmed => {
        if (!activeAppConfirmation || activeAppConfirmation.overlay !== overlay) return;
        activeAppConfirmation = null;
        document.removeEventListener('keydown', onKeyDown);
        overlay.remove();
        document.body.style.overflow = previousOverflow;
        resolveConfirmation(confirmed);
    };
    const onKeyDown = event => {
        if (event.key === 'Escape') finish(false);
    };
    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest('.app-confirm-cancel')) finish(false);
        if (event.target.closest('.app-confirm-accept')) finish(true);
    });
    document.addEventListener('keydown', onKeyDown);
    activeAppConfirmation = { overlay, promise };
    overlay.querySelector('.app-confirm-dialog')?.focus({ preventScroll: true });
    return promise;
}

// ============================================================
// MEMORIES CAROUSEL
// ============================================================
let GROUP_MEMORY_PHOTOS = [];
let memoriesIndex = 0, memoriesInterval = null;
let memoryTransitionTimer = null;
let pendingMemoryPhoto = null, pendingMemoryPhotoFile = null, pendingMemoryPhotoFiles = [], pendingMemoryPhotos = [], memoryPreviewUrl = null;
let memoryComposerPreviousOverflow = '';
const GROUP_MEMORIES_CACHE_KEY = 'nbfa_group_memories_cache_v1';

function saveGroupMemoriesCache() {
    try {
        localStorage.setItem(GROUP_MEMORIES_CACHE_KEY, JSON.stringify(GROUP_MEMORY_PHOTOS));
    } catch (error) {
        console.warn('Could not save the local Group memories cache:', error);
    }
}

function readGroupMemoriesCache() {
    try {
        const cached = JSON.parse(localStorage.getItem(GROUP_MEMORIES_CACHE_KEY) || '[]');
        return Array.isArray(cached)
            ? cached.filter(photo => photo && photo.id && photo.image && photo.image.startsWith('https://'))
            : [];
    } catch (error) {
        console.warn('Could not read the local Group memories cache:', error);
        return [];
    }
}

async function loadGroupMemories() {
    const cached = readGroupMemoriesCache();
    if (!GROUP_MEMORY_PHOTOS.length && cached.length) {
        GROUP_MEMORY_PHOTOS = cached;
        initMemoriesCarousel();
    }
    const res = await callAPI('getGroupMemories');
    if (!res.success || !Array.isArray(res.memories)) {
        const card = document.getElementById('memoriesCard');
        const empty = document.getElementById('memoryEmptyState');
        if (!GROUP_MEMORY_PHOTOS.length) {
            if (card) card.style.display = 'block';
            if (empty) {
                empty.style.display = 'block';
                empty.textContent = 'Group photos are temporarily unavailable. We will try again shortly.';
            }
        } else {
            const syncStatus = document.getElementById('memorySyncStatus');
            if (syncStatus) syncStatus.textContent = '';
        }
        return;
    }
    GROUP_MEMORY_PHOTOS = res.memories;
    saveGroupMemoriesCache();
    initMemoriesCarousel();
    const syncStatus = document.getElementById('memorySyncStatus');
    if (syncStatus) syncStatus.textContent = '';
}

function initMemoriesCarousel() {
    const card = document.getElementById('memoriesCard');
    const track = document.getElementById('memoriesCarousel');
    const dotsWrap = document.getElementById('memoriesDots');
    const emptyState = document.getElementById('memoryEmptyState');
    const frame = document.getElementById('memoriesCarouselFrame');
    const footer = document.getElementById('memoryCarouselFooter');
    const previousButton = document.getElementById('memoryPreviousButton');
    const nextButton = document.getElementById('memoryNextButton');
    const photoCount = document.getElementById('memoryPhotoCount');
    const photoPosition = document.getElementById('memoryPhotoPosition');
    if (!card || !track || !dotsWrap || !emptyState || !frame || !footer || !previousButton || !nextButton) return;
    card.style.display = 'block';
    if (!GROUP_MEMORY_PHOTOS.length) emptyState.textContent = 'Share a group photo to start your memories.';
    emptyState.style.display = GROUP_MEMORY_PHOTOS.length ? 'none' : 'block';
    frame.style.display = GROUP_MEMORY_PHOTOS.length ? 'grid' : 'none';
    footer.hidden = !GROUP_MEMORY_PHOTOS.length;
    previousButton.hidden = GROUP_MEMORY_PHOTOS.length < 2;
    nextButton.hidden = GROUP_MEMORY_PHOTOS.length < 2;
    if (photoCount) photoCount.textContent = `${GROUP_MEMORY_PHOTOS.length} ${GROUP_MEMORY_PHOTOS.length === 1 ? 'photo' : 'photos'}`;
    track.innerHTML = GROUP_MEMORY_PHOTOS.map((photo, index) => {
        const ownsPhoto = Boolean(currentUserEmail && photo.email
            && photo.email.toLowerCase() === currentUserEmail.toLowerCase());
        return `
        <figure class="memory-slide">
            <img src="${escapeHtml(photo.image)}" alt="${escapeHtml(photo.caption || `Group photo shared by ${photo.member || 'a member'}`)}" loading="${index === 0 ? 'eager' : 'lazy'}">
            ${photo.caption ? `<figcaption>${escapeHtml(photo.caption)}</figcaption>` : ''}
            ${ownsPhoto ? `<div class="memory-owner-actions" aria-label="Manage your photo">
                <button type="button" class="memory-more-button" onclick="toggleMemoryOwnerMenu(event, ${index})" aria-label="More photo actions" aria-expanded="false" title="More actions">•••</button>
                <div class="memory-owner-menu" role="menu">
                    <button type="button" role="menuitem" onclick="editMemoryCaption(${index})">Edit caption</button>
                    <button type="button" role="menuitem" onclick="recropGroupMemory(${index})">Recrop image</button>
                    <button type="button" class="is-destructive" role="menuitem" onclick="deleteGroupMemory(${index})">Delete photo</button>
                </div>
            </div>` : ''}
        </figure>
    `;
    }).join('');
    track.querySelectorAll('.memory-slide img').forEach(image => {
        let retries = 0;
        image.addEventListener('error', () => {
            if (retries >= 2) return;
            retries += 1;
            const source = image.src;
            image.src = '';
            setTimeout(() => { image.src = source; }, 700 * retries);
        });
    });
    dotsWrap.innerHTML = GROUP_MEMORY_PHOTOS.map((_, i) => `<button type="button" class="memories-dot${i === 0 ? ' active' : ''}" aria-label="Show photo ${i + 1}" aria-current="${i === 0 ? 'true' : 'false'}" onclick="goToMemory(${i})"></button>`).join('');
    memoriesIndex = 0; updateMemoriesPosition();
    if (memoriesInterval) clearInterval(memoriesInterval);
    const pauseAutoplay = () => { memoriesPaused = true; };
    const resumeAutoplay = () => { memoriesPaused = false; };
    frame.onmouseenter = pauseAutoplay;
    frame.onmouseleave = resumeAutoplay;
    frame.onfocusin = pauseAutoplay;
    frame.onfocusout = event => {
        if (!frame.contains(event.relatedTarget)) resumeAutoplay();
    };
    memoriesPaused = false;
    if (GROUP_MEMORY_PHOTOS.length > 1) {
        memoriesInterval = setInterval(() => {
            if (!memoriesPaused && !document.hidden) moveMemory(1);
        }, 3000);
    }
    if (photoPosition) photoPosition.textContent = GROUP_MEMORY_PHOTOS.length ? `1 / ${GROUP_MEMORY_PHOTOS.length}` : '';
}

let memoriesPaused = false;

function toggleMemoryOwnerMenu(event) {
    event?.stopPropagation();
    const currentMenu = event?.currentTarget?.parentElement?.querySelector('.memory-owner-menu');
    document.querySelectorAll('.memory-owner-menu.is-open').forEach(menu => {
        if (menu !== currentMenu) {
            menu.classList.remove('is-open');
            menu.parentElement?.querySelector('.memory-more-button')?.setAttribute('aria-expanded', 'false');
        }
    });
    if (!currentMenu) return;
    const open = currentMenu.classList.toggle('is-open');
    event.currentTarget.setAttribute('aria-expanded', String(open));
}

async function recropGroupMemory(index) {
    const photo = GROUP_MEMORY_PHOTOS[index];
    if (!photo || !photo.id || !photo.image || !photo.email || photo.email.toLowerCase() !== (currentUserEmail || '').toLowerCase()) {
        showToast('You can only recrop a photo you shared.', 'error');
        return;
    }
    try {
        const response = await fetch(photo.image, { mode: 'cors' });
        if (!response.ok) throw new Error('Could not open this photo for cropping.');
        const blob = await response.blob();
        const file = new File([blob], 'group-memory-recrop.jpg', { type: blob.type || 'image/jpeg' });
        const cropped = await openImageCropper(file, 'memory');
        const config = window.cloudinaryConfig || {};
        const uploaded = await uploadBlobToCloudinary(cropped, 'group-memory-recrop.jpg', config.memoryUploadPreset);
        const res = await callAPI('updateGroupMemoryImage', { id: photo.id, image: uploaded.image, publicId: uploaded.publicId });
        if (!res.success) throw new Error(res.error || 'Could not save the cropped photo.');
        photo.image = res.image;
        photo.publicId = res.publicId;
        saveGroupMemoriesCache();
        initMemoriesCarousel();
        showToast('Photo crop updated.', 'success');
    } catch (error) {
        if (error.name !== 'AbortError') showToast(error.message || 'Could not recrop this photo.', 'error');
    }
}

async function editMemoryCaption(index) {
    const photo = GROUP_MEMORY_PHOTOS[index];
    if (!photo || !photo.id || !photo.email || photo.email.toLowerCase() !== (currentUserEmail || '').toLowerCase()) {
        showToast('You can only edit a photo you shared.', 'error');
        return;
    }
    const overlay = document.createElement('div');
    overlay.className = 'memory-caption-overlay';
    overlay.innerHTML = `<div class="memory-caption-dialog" role="dialog" aria-modal="true" aria-labelledby="memoryCaptionTitle">
        <h3 id="memoryCaptionTitle">Edit photo caption</h3>
        <label for="memoryCaptionEditInput">Caption</label>
        <textarea id="memoryCaptionEditInput" maxlength="200" rows="3" placeholder="Add a caption to this memory">${escapeHtml(photo.caption || '')}</textarea>
        <div class="memory-composer-actions">
            <button type="button" class="memory-cancel-btn" data-action="cancel">Cancel</button>
            <button type="button" data-action="recrop">Recrop image</button>
            <button type="button" data-action="save">Save caption</button>
        </div>
    </div>`;
    document.body.appendChild(overlay);
    const captionInput = overlay.querySelector('#memoryCaptionEditInput');
    overlay.addEventListener('click', event => {
        if (event.target === overlay || event.target.closest('[data-action="cancel"]')) overlay.remove();
    });
    overlay.querySelector('[data-action="recrop"]').addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        overlay.remove();
        await recropGroupMemory(index);
    });
    overlay.querySelector('[data-action="save"]').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const res = await callAPI('updateGroupMemoryCaption', { id: photo.id, caption: captionInput.value.trim() });
            if (!res.success) throw new Error(res.error || 'Could not update the caption.');
            photo.caption = res.caption;
            saveGroupMemoriesCache();
            initMemoriesCarousel();
            overlay.remove();
            showToast('Caption updated.', 'success');
        } catch (error) {
            showToast(error.message || 'Could not update the caption.', 'error');
            button.disabled = false;
        }
    });
    captionInput.focus();
}

async function deleteGroupMemory(index) {
    const photo = GROUP_MEMORY_PHOTOS[index];
    if (!photo || !photo.id || !photo.email || photo.email.toLowerCase() !== (currentUserEmail || '').toLowerCase()) {
        showToast('You can only delete a photo you shared.', 'error');
        return;
    }
    if (!window.confirm('Delete this photo from Group memories? This cannot be undone.')) return;
    try {
        const res = await callAPI('deleteGroupMemory', { id: photo.id });
        if (!res.success) throw new Error(res.error || 'Could not delete the photo.');
        GROUP_MEMORY_PHOTOS = GROUP_MEMORY_PHOTOS.filter(item => item.id !== photo.id);
        saveGroupMemoriesCache();
        memoriesIndex = Math.min(memoriesIndex, Math.max(0, GROUP_MEMORY_PHOTOS.length - 1));
        initMemoriesCarousel();
        showToast('Photo deleted from Group memories.', 'success');
    } catch (error) {
        showToast(error.message || 'Could not delete the photo.', 'error');
    }
}

async function downloadGroupMemory(index) {
    const photo = GROUP_MEMORY_PHOTOS[index];
    if (!photo || !photo.image) {
        showToast('That group photo is no longer available.', 'error');
        return;
    }
    try {
        const response = await fetch(photo.image, { mode: 'cors' });
        if (!response.ok) throw new Error('The image server did not return the photo.');
        const blob = await response.blob();
        const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[blob.type] || 'jpg';
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = `NBFA_Group_Memory_${index + 1}.${extension}`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    } catch (error) {
        console.error('Group photo download failed:', error);
        showToast('Could not download this photo. Please try again.', 'error');
    }
}

function moveMemory(direction) {
    if (!GROUP_MEMORY_PHOTOS.length) return;
    memoriesIndex = (memoriesIndex + direction + GROUP_MEMORY_PHOTOS.length) % GROUP_MEMORY_PHOTOS.length;
    updateMemoriesPosition();
}

function goToMemory(index) {
    if (index < 0 || index >= GROUP_MEMORY_PHOTOS.length) return;
    memoriesIndex = index;
    updateMemoriesPosition();
}

function toggleMemoryComposer(forceOpen) {
    const composer = document.getElementById('memoryComposer');
    if (!composer) return;
    const open = typeof forceOpen === 'boolean' ? forceOpen : composer.style.display === 'none';
    composer.style.display = open ? 'flex' : 'none';
    composer.setAttribute('aria-hidden', String(!open));
    memoriesPaused = open;
    if (open) {
        memoryComposerPreviousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        composer.querySelector('.memory-composer-dialog')?.focus();
    } else {
        document.body.style.overflow = memoryComposerPreviousOverflow;
        pendingMemoryPhoto = null;
        pendingMemoryPhotoFile = null;
        pendingMemoryPhotoFiles = [];
        pendingMemoryPhotos = [];
        if (memoryPreviewUrl) URL.revokeObjectURL(memoryPreviewUrl);
        memoryPreviewUrl = null;
        const preview = document.getElementById('memoryPhotoPreviewWrap');
        if (preview) preview.hidden = true;
    }
    if (!open) {
        document.getElementById('memoryPhotoInput').value = '';
        const pickerTitle = document.getElementById('memoryPhotoPickerTitle');
        if (pickerTitle) pickerTitle.textContent = 'Choose photos';
        document.getElementById('memoryCaptionInput').value = '';
        document.getElementById('memoryUploadStatus').textContent = '';
    }
}

async function prepareMemoryPhoto(event) {
    const input = event.currentTarget;
    const files = Array.from(input.files || []);
    if (!files.length) return;
    const status = document.getElementById('memoryUploadStatus');
    const pickerTitle = document.getElementById('memoryPhotoPickerTitle');
    if (pickerTitle) pickerTitle.textContent = files.length === 1 ? files[0].name : `${files.length} photos selected`;
    if (files.some(file => !ALLOWED_CLOUDINARY_IMAGE_TYPES.has(file.type))) {
        if (status) status.textContent = 'Use JPG, PNG, or WebP images only.';
        input.value = '';
        if (pickerTitle) pickerTitle.textContent = 'Choose photos';
        return;
    }
    if (files.some(file => file.size > MAX_CLOUDINARY_IMAGE_SIZE)) {
        if (status) status.textContent = 'Each photo must be smaller than 5 MB.';
        input.value = '';
        if (pickerTitle) pickerTitle.textContent = 'Choose photos';
        return;
    }
    pendingMemoryPhotoFiles = files;
    pendingMemoryPhotoFile = files[0];
    pendingMemoryPhotos = [];
    for (let index = 0; index < files.length; index += 1) {
        if (status) status.textContent = `Adjusting photo ${index + 1} of ${files.length}...`;
        const accepted = await cropMemoryPhoto(files[index]);
        if (!accepted) break;
    }
    if (status) status.textContent = pendingMemoryPhotos.length
        ? `${pendingMemoryPhotos.length} photo${pendingMemoryPhotos.length === 1 ? '' : 's'} ready to share.`
        : '';
}

async function cropMemoryPhoto(file, replaceIndex = null) {
    try {
        const cropped = await openImageCropper(file, 'memory');
        if (replaceIndex === null) pendingMemoryPhotos.push(cropped);
        else pendingMemoryPhotos[replaceIndex] = cropped;
        pendingMemoryPhoto = pendingMemoryPhotos[0] || null;
        if (memoryPreviewUrl) URL.revokeObjectURL(memoryPreviewUrl);
        memoryPreviewUrl = URL.createObjectURL(pendingMemoryPhotos[0]);
        const preview = document.getElementById('memoryPhotoPreview');
        if (preview) preview.src = memoryPreviewUrl;
        const wrap = document.getElementById('memoryPhotoPreviewWrap');
        if (wrap) wrap.hidden = false;
        return true;
    } catch (error) {
        if (error.name !== 'AbortError') {
            const status = document.getElementById('memoryUploadStatus');
            if (status) status.textContent = error.message || 'Could not crop this photo.';
        }
        return false;
    }
}

function recropMemoryPhoto() {
    if (pendingMemoryPhotoFile) cropMemoryPhoto(pendingMemoryPhotoFile, 0);
}

async function postGroupMemory() {
    const input = document.getElementById('memoryPhotoInput');
    const captionInput = document.getElementById('memoryCaptionInput');
    const status = document.getElementById('memoryUploadStatus');
    const button = document.getElementById('memorySubmitBtn');
    if (!pendingMemoryPhotos.length) {
        status.textContent = 'Choose a photo and adjust its crop to share.';
        return;
    }
    button.disabled = true;
    status.textContent = 'Uploading photo...';
    try {
        const config = window.cloudinaryConfig || {};
        const savedMemories = [];
        for (let index = 0; index < pendingMemoryPhotos.length; index += 1) {
            status.textContent = `Uploading photo ${index + 1} of ${pendingMemoryPhotos.length}...`;
            const uploaded = await uploadBlobToCloudinary(pendingMemoryPhotos[index], `group-memory-${index + 1}.jpg`, config.memoryUploadPreset);
            status.textContent = `Saving photo ${index + 1} of ${pendingMemoryPhotos.length}...`;
            const res = await callAPI('saveGroupMemory', {
                image: uploaded.image,
                publicId: uploaded.publicId,
                caption: captionInput.value.trim()
            });
            if (!res.success) throw new Error(res.error || `Could not save photo ${index + 1}.`);
            savedMemories.push(res.memory);
        }
        GROUP_MEMORY_PHOTOS.unshift(...savedMemories);
        GROUP_MEMORY_PHOTOS = GROUP_MEMORY_PHOTOS.slice(0, 50);
        saveGroupMemoriesCache();
        initMemoriesCarousel();
        toggleMemoryComposer(false);
        showToast(`${savedMemories.length} photo${savedMemories.length === 1 ? '' : 's'} shared with the group.`, 'success');
    } catch (error) {
        status.textContent = error.message;
    } finally {
        button.disabled = false;
    }
}

function updateMemoriesPosition() {
    const track = document.getElementById('memoriesCarousel');
    if (track) {
        const slides = [...track.querySelectorAll('.memory-slide')];
        const nextSlide = slides[memoriesIndex];
        const previousSlide = slides.find(slide => slide.classList.contains('is-active'));
        if (nextSlide && previousSlide !== nextSlide) {
            const effects = ['fade', 'zoom', 'lift', 'flip'];
            const effect = effects[Math.floor(Math.random() * effects.length)];
            slides.forEach(slide => slide.classList.remove('memory-is-leaving', 'memory-effect-fade', 'memory-effect-zoom', 'memory-effect-lift', 'memory-effect-flip'));
            if (previousSlide) {
                previousSlide.classList.remove('is-active');
                previousSlide.classList.add('memory-is-leaving');
            }
            nextSlide.classList.add('is-active', `memory-effect-${effect}`);
            slides.filter(slide => slide !== nextSlide && slide !== previousSlide).forEach(slide => slide.classList.remove('is-active'));
            if (memoryTransitionTimer) clearTimeout(memoryTransitionTimer);
            memoryTransitionTimer = setTimeout(() => {
                slides.forEach(slide => slide.classList.remove('memory-is-leaving', 'memory-effect-fade', 'memory-effect-zoom', 'memory-effect-lift', 'memory-effect-flip'));
                memoryTransitionTimer = null;
            }, 720);
        } else if (nextSlide) {
            slides.forEach(slide => slide.classList.toggle('is-active', slide === nextSlide));
        }
    }
    document.querySelectorAll('.memories-dot').forEach((dot, i) => {
        const active = i === memoriesIndex;
        dot.classList.toggle('active', active);
        dot.setAttribute('aria-current', active ? 'true' : 'false');
    });
    const photoPosition = document.getElementById('memoryPhotoPosition');
    if (photoPosition && GROUP_MEMORY_PHOTOS.length) photoPosition.textContent = `${memoriesIndex + 1} / ${GROUP_MEMORY_PHOTOS.length}`;
}

async function loadGroupMessages() {
    const container = document.getElementById('groupMessages');
    if (!container) return;
    if (DEVELOPMENT_PREVIEW_ENABLED) {
        const requestContainer = document.getElementById('groupInboxRequests');
        if (requestContainer) requestContainer.innerHTML = '';
        container.innerHTML = '<div class="empty-state">No group messages yet.</div>';
        unreadGroupMessages = 0;
        updateUnreadIndicators();
        return;
    }
    const res = await callAPI('getGroupMessages');
    if (!res.success) {
        const requestContainer = document.getElementById('groupInboxRequests');
        if (requestContainer) requestContainer.innerHTML = '';
        container.innerHTML = `<div class="empty-state">${escapeHtml(res.error || 'Could not load group messages.')}</div>`;
        unreadGroupMessages = 0;
        updateUnreadIndicators();
        return;
    }

    const requests = Array.isArray(res.joinRequests) ? res.joinRequests : [];
    const requestContainer = document.getElementById('groupInboxRequests');
    requestContainer.innerHTML = requests.length ? `
        <section class="group-request-feed">
            <h3>Requests to join</h3>
            ${requests.map(request => `
                <article class="group-request-item">
                    <strong>${escapeHtml(request.name)}</strong>
                    <span>${escapeHtml(request.email)}</span>
                    <time>${request.created_at ? new Date(request.created_at).toLocaleDateString() : ''}</time>
                </article>
            `).join('')}
        </section>
    ` : '';

    const messages = Array.isArray(res.messages) ? res.messages : [];
    let messagesSeenAt = localStorage.getItem(unreadStorageKey('group_messages')) || '';
    const latestMessageAt = messages.reduce((latest, message) => String(message.created_at || '') > latest ? String(message.created_at || '') : latest, '');
    if (!messagesSeenAt && latestMessageAt) {
        messagesSeenAt = latestMessageAt;
        localStorage.setItem(unreadStorageKey('group_messages'), messagesSeenAt);
    }
    unreadGroupMessages = messages.filter(message =>
        message.email !== currentUserEmail && message.created_at && String(message.created_at) > messagesSeenAt
    ).length;
    updateUnreadIndicators();
    if (!messages.length) {
        unreadGroupMessages = 0;
        updateUnreadIndicators();
        container.innerHTML = '<div class="empty-state">No messages yet. Start the group conversation.</div>';
        return;
    }
    const canDeleteMessages = hasAdminPortalAccess();
    container.innerHTML = messages.map(message => `
        <article class="group-message${message.email === currentUserEmail ? ' own-message' : ''}">
            <div class="group-message-meta">
                <strong>${escapeHtml(message.member || 'Group member')}</strong>
                <time>${message.created_at ? new Date(message.created_at).toLocaleString() : ''}</time>
                ${canDeleteMessages && message.id ? `<button type="button" class="group-message-delete" data-group-message-id="${escapeHtml(message.id)}" aria-label="Delete message from ${escapeHtml(message.member || 'group member')}" title="Delete message">Delete</button>` : ''}
            </div>
            <p>${escapeHtml(message.message)}</p>
        </article>
    `).join('');
    container.querySelectorAll('.group-message-delete').forEach(button => {
        button.addEventListener('click', () => deleteGroupMessage(button));
    });
    scrollGroupMessagesToBottom();
    if (document.getElementById('groupChatModal')?.style.display !== 'none') markGroupMessagesRead();
}

async function deleteGroupMessage(button) {
    if (!hasAdminPortalAccess()) {
        showToast('Only administrators or developers can delete group messages.', 'error');
        return;
    }
    const id = button?.dataset.groupMessageId;
    if (!id) {
        showToast('Could not identify this group message.', 'error');
        return;
    }
    const confirmed = await showAppConfirmation({
        title: 'Delete this group message?',
        message: 'This will permanently remove the message from the group inbox for everyone.',
        confirmLabel: 'Delete message',
        destructive: true
    });
    if (!confirmed) return;

    button.disabled = true;
    try {
        const res = await callAPI('deleteGroupMessage', { id });
        if (!res.success) throw new Error(res.error || 'Could not delete the group message.');
        await loadGroupMessages();
        showToast('Group message deleted.', 'success');
    } catch (error) {
        button.disabled = false;
        showToast(error.message || 'Could not delete the group message.', 'error');
    }
}

async function sendGroupMessage(event) {
    event.preventDefault();
    const input = document.getElementById('groupMessageInput');
    const button = document.getElementById('groupMessageSendBtn');
    const message = input.value.trim();
    if (!message) return;
    if (message.length > 1000) {
        showToast('Messages must be 1,000 characters or fewer.', 'error');
        return;
    }
    button.disabled = true;
    try {
        const res = await callAPI('sendGroupMessage', { message });
        if (!res.success) throw new Error(res.error || 'Could not send the message.');
        input.value = '';
        await loadGroupMessages();
    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

let groupChatReturnMarker = null;
let groupChatReturnFocus = null;
let groupChatPreviousOverflow = '';

function toggleGroupChat(open, opener = null) {
    const modal = document.getElementById('groupChatModal');
    if (!modal) return;

    if (open) {
        if (modal.style.display !== 'none') return;
        groupChatReturnFocus = opener || document.activeElement;
        groupChatReturnMarker = document.createComment('Group chat modal position');
        modal.parentNode.insertBefore(groupChatReturnMarker, modal);
        document.body.appendChild(modal);
        modal.style.display = 'grid';
        modal.setAttribute('aria-hidden', 'false');
        groupChatPreviousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        document.addEventListener('keydown', handleGroupChatKeydown);
        modal.querySelector('.group-chat-modal-dialog')?.focus({ preventScroll: true });
        document.getElementById('groupMessageInput')?.focus({ preventScroll: true });
        markGroupMessagesRead();
        loadGroupMessages();
        setTimeout(() => {
            syncChatViewport();
            scrollGroupMessagesToBottom('smooth');
        }, 80);
        return;
    }

    if (modal.style.display === 'none') return;
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    if (groupChatReturnMarker?.parentNode) {
        groupChatReturnMarker.parentNode.replaceChild(modal, groupChatReturnMarker);
    }
    groupChatReturnMarker = null;
    document.body.style.overflow = groupChatPreviousOverflow;
    document.removeEventListener('keydown', handleGroupChatKeydown);
    if (groupChatReturnFocus?.isConnected && currentTab === 'meetings') {
        groupChatReturnFocus.focus({ preventScroll: true });
    }
    groupChatReturnFocus = null;
}

function handleGroupChatKeydown(event) {
    if (event.key === 'Escape') {
        toggleGroupChat(false);
        return;
    }
    if (event.key !== 'Tab') return;
    const modal = document.getElementById('groupChatModal');
    const focusable = [...modal.querySelectorAll('button:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

// ============================================================
// LOGOUT
// ============================================================
async function logout(event) {
    if (event) { event.stopPropagation(); event.preventDefault(); }
    const confirmed = await showAppConfirmation({
        title: 'Log out of your account?',
        message: 'Your group information is saved. You can securely sign back in whenever you are ready.',
        confirmLabel: 'Log out',
        destructive: true
    });
    if (!confirmed) return;
    if (window.firebaseAuth) await window.firebaseAuth.signOut();
    if (countdownInterval) clearInterval(countdownInterval);
    localStorage.removeItem('legacy_current_user');
    localStorage.removeItem('legacy_current_email');
    localStorage.removeItem('legacy_current_role');
    localStorage.removeItem('legacy_active_tab');
    if (refreshInterval) clearInterval(refreshInterval);
    currentUser = null; currentUserDisplayName = null; currentUserEmail = null; currentUserRole = null;
    currentUserPhone = ''; currentUserPhoneCountry = ''; currentUserPhoneDialCode = '';
    currentUserPhoneVerifiedAt = ''; currentUserPhoneVerifiedBy = '';
    allRecords = []; allMembers = []; pendingLoans = []; completedLoans = []; pendingTransactions = []; isLoading = false; dashboardLoaded = false;
    pushSubscription = null; serviceWorkerRegistered = false;
    document.getElementById('appContainer').classList.remove('active');
    document.getElementById('tabBar').style.display = 'none';
    document.getElementById('sidebarNav')?.classList.remove('active');
    document.getElementById('loginOverlay').classList.add('active');
    document.getElementById('loginError').style.display = 'none';
    showToast('Logged out', 'success');
}

// ============================================================
// DOM READY
// ============================================================
function initializeModalScrollLock() {
    const modalSelector = '.modal, .history-modal, .profile-modal-overlay';
    const syncScrollLock = () => {
        const isOpen = Array.from(document.querySelectorAll(modalSelector)).some(modal => {
            const style = window.getComputedStyle(modal);
            return style.display !== 'none' && style.visibility !== 'hidden';
        });
        document.documentElement.classList.toggle('modal-open', isOpen);
    };
    const observer = new MutationObserver(syncScrollLock);
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
        childList: true,
        subtree: true
    });
    syncScrollLock();
}

const initializeApp = async () => {
    initializeModalScrollLock();
    if (DEVELOPMENT_PREVIEW_ENABLED) {
        initializeDevelopmentPreview();
        return;
    }
    if (!window.firebaseAuth) {
        throw window.firebaseInitializationError || new Error('Firebase could not be initialized. Check your connection and reload.');
    }
    await new Promise((resolve, reject) => {
        let unsubscribe = () => {};
        unsubscribe = window.firebaseAuth.onAuthStateChanged(
            () => {
                unsubscribe();
                resolve();
            },
            error => {
                unsubscribe();
                reject(error);
            }
        );
    });
    const hasPersistentSession = checkPersistentLogin();
    if (hasPersistentSession) {
        const account = await callAPI('bootstrapProfile');
        if (!account.success) {
            document.getElementById('loginOverlay').classList.add('active');
            const errorEl = document.getElementById('loginError');
            errorEl.textContent = account.error || 'Could not verify your account. Please try again.';
            errorEl.style.display = 'block';
            return;
        }
        if (account.status !== 'approved') {
            await window.firebaseAuth.signOut();
            localStorage.removeItem('legacy_current_user');
            localStorage.removeItem('legacy_current_email');
            localStorage.removeItem('legacy_current_role');
            document.getElementById('loginOverlay').classList.add('active');
            const errorEl = document.getElementById('loginError');
            errorEl.textContent = account.status === 'pending'
                ? 'Your registration is awaiting approval. Please contact the treasurer.'
                : (account.error || 'This account is not approved. Please contact the treasurer.');
            errorEl.style.display = 'block';
            return;
        }
        currentUser = account.name || currentUser;
        currentUserDisplayName = account.displayName || currentUser;
        currentUserEmail = account.email || currentUserEmail;
        currentUserRole = account.role || 'member';
        currentUserPhone = account.phone || '';
        currentUserPhoneCountry = account.phoneCountry || '';
        currentUserPhoneDialCode = account.phoneDialCode || '';
        currentUserPhoneVerifiedAt = account.phoneVerifiedAt || '';
        currentUserPhoneVerifiedBy = account.phoneVerifiedBy || '';
        localStorage.setItem('legacy_current_user', currentUser);
        localStorage.setItem('legacy_current_email', currentUserEmail);
        localStorage.setItem('legacy_current_role', currentUserRole);
        const profileImageLoad = callAPI('getProfileImage', { email: currentUserEmail }).then(profileRes => {
            if (profileRes.success && profileRes.image) {
                userProfileImage = profileRes.image;
                localStorage.setItem(`legacy_profile_image_${currentUserEmail.toLowerCase()}`, userProfileImage);
                updateHeaderAvatar();
            }
        });
        document.getElementById('loginOverlay').classList.remove('active');
        document.getElementById('appContainer').classList.add('active');
        document.getElementById('tabBar').style.display = 'flex';
        document.getElementById('sidebarNav')?.classList.add('active');
        document.getElementById('loggedInUser').innerText = currentUserDisplayName;
        document.getElementById('date').value = getLocalDateInputValue();
        updateHeaderAvatar();
        showHideDeveloperPortal();
        showHidePendingTab();
        showBalanceLoading(true);
        updateDashboardGreeting();
        initMemoriesCarousel();
        activateCurrentTab();
        await Promise.all([
            ...(currentTab === 'loans' ? [] : [loadAllData()]),
            loadGroupMemories(),
            profileImageLoad,
            loadMeetingMinutes(),
            loadScheduledMeeting(),
            loadMembersList()
        ]);
        showBalanceLoading(false);
        setTimeout(() => checkAndShowNotificationPrompt(), 3000);
        if (refreshInterval) clearInterval(refreshInterval);
        refreshInterval = setInterval(() => {
            if (currentUser) {
                loadAllData(true);
                loadGroupMessages();
                loadGroupMemories();
                loadScheduledMeeting();
                loadMembersList();
            }
        }, 30000);
    } else {
        document.getElementById('loginOverlay').classList.add('active');
    }

    document.getElementById('addBtn').onclick = addRecord;
    document.getElementById('exportPdfBtn').onclick = exportToPDF;
    document.querySelectorAll('.tab, .sidebar-link').forEach(tab => { tab.onclick = () => activateTab(tab.dataset.panel); });
};

function initializeDevelopmentPreview() {
    const sampleMembers = [
        { name: 'Alex Morgan', email: 'alex.morgan@example.test' },
        { name: 'Taylor Quinn', email: 'taylor.quinn@example.test' },
        { name: 'Jordan Lee', email: 'jordan.lee@example.test' },
        { name: 'Casey Rivers', email: 'casey.rivers@example.test' }
    ];
    const daysAgo = days => {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return date.toISOString().split('T')[0];
    };

    currentUser = 'Alex Morgan';
    currentUserDisplayName = currentUser;
    currentUserEmail = 'alex.morgan@example.test';
    currentUserRole = 'member';
    currentTab = 'transactions';
    allMembers = sampleMembers.map(member => member.name);
    allMembersData = sampleMembers;
    allRecords = [
        { date: daysAgo(1), member: 'Alex Morgan', type: 'Savings', amount: 12000 },
        { date: daysAgo(2), member: 'Taylor Quinn', type: 'Loan Repayment', amount: 8500 },
        { date: daysAgo(3), member: 'Jordan Lee', type: 'Loan Taken', amount: 25000 },
        { date: daysAgo(4), member: 'Casey Rivers', type: 'Savings', amount: 10000 },
        { date: daysAgo(6), member: 'Taylor Quinn', type: 'Savings', amount: 15000 }
    ];
    lastGroupSummary = {
        savings: 184500,
        outstanding: 42000,
        interestEarned: 5600,
        loansTaken: 68000,
        repaid: 24000
    };

    document.getElementById('loginOverlay').classList.remove('active');
    document.getElementById('appContainer').classList.add('active', 'dashboard-active');
    document.getElementById('tabBar').style.display = 'flex';
    document.getElementById('sidebarNav').classList.add('active');
    document.getElementById('developmentPreviewNotice').hidden = false;
    document.getElementById('loggedInUser').textContent = currentUserDisplayName;
    document.getElementById('date').value = getLocalDateInputValue();

    updateHeaderAvatar();
    updateDashboardGreeting();
    showHideDeveloperPortal();
    showHidePendingTab();
    updateMemberDropdowns();
    renderRecentActivity();
    updateAboutStats();
    renderMembersList(allMembersData);
    document.getElementById('memberCountBadge').textContent = `${allMembersData.length} Members`;
    document.getElementById('summarySkeleton').style.display = 'none';
    document.getElementById('summaryContent').style.display = 'block';
    if (typeof Chart !== 'undefined') renderChart(lastGroupSummary);
    renderWalletBalance();
    activateCurrentTab();

    document.getElementById('addBtn').onclick = addRecord;
    document.getElementById('exportPdfBtn').onclick = exportToPDF;
    document.querySelectorAll('.tab, .sidebar-link').forEach(tab => { tab.onclick = () => activateTab(tab.dataset.panel); });
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('aboutPanel')?.remove();
    document.querySelectorAll('[data-panel="about"]').forEach(element => element.remove());
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', syncChatViewport);
        window.visualViewport.addEventListener('scroll', syncChatViewport);
    }
    document.getElementById('groupMessageInput')?.addEventListener('focus', () => {
        setTimeout(() => {
            syncChatViewport();
            scrollGroupMessagesToBottom('smooth');
        }, 250);
    });
    initializeAuthVideoLoop();
    initializeGoogleSignIn();
    initializeApp().catch(error => {
        console.error('App initialization failed:', error);
        document.getElementById('appContainer')?.classList.remove('active', 'dashboard-active');
        const tabBar = document.getElementById('tabBar');
        if (tabBar) tabBar.style.display = 'none';
        document.getElementById('sidebarNav')?.classList.remove('active');
        const loginOverlay = document.getElementById('loginOverlay');
        if (loginOverlay) loginOverlay.classList.add('active');
        const errorEl = document.getElementById('loginError');
        if (errorEl) {
            errorEl.textContent = error.message || 'Could not connect to Firebase. Please reload and try again.';
            errorEl.style.display = 'block';
        }
    }).finally(() => {
        document.body.classList.remove('app-loading');
        document.getElementById('startupLoading')?.remove();
    });
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
window.loginWithGoogle = loginWithGoogle;
window.verifyOtpAndLogin = verifyOtpAndLogin;
window.resendOtpCode = resendOtpCode;
window.backToLoginFromOtp = backToLoginFromOtp;
window.registerUser = registerUser;
window.showRegisterForm = showRegisterForm;
window.showLoginForm = showLoginForm;
window.showForgotPasswordForm = showForgotPasswordForm;
window.requestPasswordReset = requestPasswordReset;
window.openProfileModal = openProfileModal;
window.saveOwnProfile = saveOwnProfile;
window.openAdminPortal = openAdminPortal;
window.openDeveloperPortalModal = openDeveloperPortalModal;
window.closeDeveloperPortalModal = closeDeveloperPortalModal;
window.toggleMemoryOwnerMenu = toggleMemoryOwnerMenu;
window.recropGroupMemory = recropGroupMemory;
window.saveMemberPhone = saveMemberPhone;
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
window.openAddUserModal = openAddUserModal;
window.createGroupUser = createGroupUser;
window.exportAuditLog = exportAuditLog;
window.deleteGroupMessage = deleteGroupMessage;
window.toggleGroupChat = toggleGroupChat;
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
window.downloadWalletCard = downloadWalletCard;
window.downloadGroupMemory = downloadGroupMemory;
window.submitTransactionEdit = submitTransactionEdit;
window.openEditTransactionModal = openEditTransactionModal;
window.rejectTransactionEdit = rejectTransactionEdit;
