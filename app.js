// ============================================================
        // CONFIGURATION
        // ============================================================
        // FIX: API_URL is now defined and points at your own Vercel proxy
        // (/api/sheets-proxy) instead of calling Google Apps Script directly.
        // This avoids the "API_URL is not defined" ReferenceError and the
        // CORS errors you were seeing, because the browser only ever talks
        // to your own domain — your serverless function does the
        // server-to-server call to Apps Script behind the scenes.
        const API_URL = "/api/sheets-proxy";
        const TREASURER_NAME = "Mrs. Kithinji";

        // VAPID Public Key from your backend
        const VAPID_PUBLIC_KEY = 'BB4N47xyKjLw-K29lXDolpcht45pVZcqV4m-Iw-8tJBk8g21yE66KVJmxbNOIDEIRBun-JDACI0lK4MRIvVwYH0';
    

        let allRecords = [],
            allMembers = [],
            allMembersData = [],
            pendingLoans = [],
            completedLoans = [],
            pendingTransactions = [],
            pendingEditsMap = {},
            activeLoans = [],
            loansAwaitingDueDate = [],
            currentUser = null,
            currentUserEmail = null;
        let currentTab = localStorage.getItem('legacy_active_tab') || 'transactions';
        let countdownInterval = null;
        let refreshInterval = null;
        let userProfileImage = localStorage.getItem('legacy_profile_image') || null;
        let isLoading = false;
        let chartInstance = null;
        // Per-session cache: email -> photo data URL. Once a member's
        // photo has been fetched, it's never fetched again for the rest
        // of this session, even across dashboard refreshes — this is
        // what makes the "only download each photo once" part work.
        const memberPhotoCache = {};
        let serviceWorkerRegistered = false;
        let pushSubscription = null;

        // ============================================================
        // SPLASH SCREEN
        // ============================================================
        function hideSplashScreen() {
            const splash = document.getElementById('splashScreen');
            splash.classList.add('hidden');
            setTimeout(() => {
                splash.style.display = 'none';
            }, 500);
        }

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

        function showLoginLoading(show) {
            const btn = document.getElementById('loginBtn');
            if (show) { btn.disabled = true;
                btn.innerHTML = '<span class="login-loading"></span> Logging in...'; } else { btn.disabled = false;
                btn.innerHTML = 'Login'; }
        }

        function showRegisterLoading(show) {
            const btn = document.querySelector('#registerForm .login-btn');
            if (show) { btn.disabled = true;
                btn.innerHTML = '<span class="login-loading"></span> Creating account...'; } else { btn.disabled = false;
                btn.innerHTML = 'Create Account'; }
        }

        // Small helper used to stagger groups of requests instead of
        // firing them all in the same instant — Apps Script can return a
        // throttling/interstitial HTML page (which surfaces as a 502)
        // when hit with several simultaneous requests at once.
        function delay(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        function getInitials(name) {
            if (!name) return '?';
            return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        }

        // ============================================================
        // PERSISTENT LOGIN
        // ============================================================
        function checkPersistentLogin() {
            const saved = localStorage.getItem('legacy_current_user');
            const savedEmail = localStorage.getItem('legacy_current_email');
            if (saved && savedEmail) {
                currentUser = saved;
                currentUserEmail = savedEmail;
                return true;
            }
            return false;
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

        async function saveProfileImageToServer(imageData) {
            try {
                const res = await callAPI('saveProfileImage', {
                    email: currentUserEmail,
                    image: imageData
                });
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

        function getProfileImage() {
            return userProfileImage || localStorage.getItem('legacy_profile_image') || null;
        }

        // ============================================================
        // LOGIN / REGISTRATION FUNCTIONS
        // ============================================================
        function showRegisterForm() {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'block';
            document.getElementById('forgotPasswordForm').style.display = 'none';
            document.getElementById('loginError').style.display = 'none';
            document.getElementById('registerError').style.display = 'none';
            const sub = document.getElementById('loginSubtitle');
            if (sub) sub.textContent = 'Join the circle — create your account';
        }

        function showLoginForm() {
            document.getElementById('loginForm').style.display = 'block';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotPasswordForm').style.display = 'none';
            document.getElementById('loginError').style.display = 'none';
            document.getElementById('registerError').style.display = 'none';
            document.getElementById('resetError').style.display = 'none';
            document.getElementById('resetSuccess').style.display = 'none';
            const sub = document.getElementById('loginSubtitle');
            if (sub) sub.textContent = 'Welcome back — login to access your account';
        }

        function showForgotPasswordForm() {
            document.getElementById('loginForm').style.display = 'none';
            document.getElementById('registerForm').style.display = 'none';
            document.getElementById('forgotPasswordForm').style.display = 'block';
            document.getElementById('loginError').style.display = 'none';
            document.getElementById('resetError').style.display = 'none';
            document.getElementById('resetSuccess').style.display = 'none';
            const sub = document.getElementById('loginSubtitle');
            if (sub) sub.textContent = "We'll help you get back in";
        }

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
                    successEl.textContent = '✅ Password reset successfully! Your new password is: ' + res.newPassword;
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

            showRegisterLoading(true);

            try {
                const res = await callAPI('register', { email, name, password });
                if (res.success) {
                    showToast('Account created successfully! Please login.', 'success');
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

            showRegisterLoading(false);
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

            showLoginLoading(true);

            try {
                const res = await callAPI('login', { email, password });
                if (res.success) {
                    currentUser = res.name;
                    currentUserEmail = email;
                    localStorage.setItem('legacy_current_user', currentUser);
                    localStorage.setItem('legacy_current_email', email);

                    const profileRes = await callAPI('getProfileImage', { email });
                    if (profileRes.success && profileRes.image) {
                        userProfileImage = profileRes.image;
                        localStorage.setItem('legacy_profile_image', userProfileImage);
                    } else {
                        userProfileImage = null;
                        localStorage.removeItem('legacy_profile_image');
                    }

                    document.getElementById('loginOverlay').classList.remove('active');
                    document.getElementById('appContainer').classList.add('active');
                    document.getElementById('tabBar').style.display = 'flex';
                    document.getElementById('sidebarNav')?.classList.add('active');
                    document.getElementById('loggedInUser').innerText = currentUser;
                    document.getElementById('date').value = new Date().toISOString().split('T')[0];

                    updateHeaderAvatar();

                    const pendingTab = document.getElementById('pendingTab');
                    if (pendingTab) pendingTab.style.display = isTreasurer() ? 'flex' : 'none';
                    const pendingSidebarLink = document.getElementById('pendingSidebarLink');
                    if (pendingSidebarLink) pendingSidebarLink.style.display = isTreasurer() ? 'flex' : 'none';

                    showBalanceLoading(true);
                    updateDashboardGreeting();
                    initMemoriesCarousel();
                    // FIX (performance — the real "takes forever" cause):
                    // these 4 fetches have no dependency on each other but
                    // were run with sequential awaits, meaning the browser
                    // waited for each full Apps Script round-trip to finish
                    // before even starting the next one — 4 round-trips
                    // stacked back-to-back instead of happening at once.
                    // This only affected the FIRST login of a session; the
                    // persistent-login path (returning via a saved session)
                    // already ran these in parallel correctly.
                    //
                    // FIX (502s on login): running all 4 via Promise.all
                    // fired them in the exact same instant, which is a
                    // burst large enough to occasionally overwhelm Apps
                    // Script (it returns an HTML throttling page instead
                    // of JSON, which surfaces as a 502 — confirmed via
                    // Vercel logs). loadAllData() is by far the heaviest
                    // single call (multiple sheet reads bundled into one
                    // execution), so it goes first alone; the three
                    // lighter calls are staggered by 150ms each so Apps
                    // Script never sees more than one new request landing
                    // at once.
                    await loadAllData();
                    await delay(150);
                    await Promise.all([
                        loadMeetingMinutes(),
                        delay(150).then(() => loadScheduledMeeting()),
                        delay(300).then(() => loadMembersList())
                    ]);
                    // FIX: activateTab() also calls loadAllData() internally
                    // (needed for normal tab switches, where fresh data IS
                    // wanted) — but right here, data was JUST fetched by the
                    // Promise.all above. Calling activateTab() unconditionally
                    // triggered a second, fully redundant fetch on every
                    // single login. Swap the panel/nav state directly
                    // instead of going through the function that also
                    // re-fetches.
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

                    // Initialize push notifications
                    setTimeout(() => {
                        checkAndShowNotificationPrompt();
                        registerServiceWorker();
                    }, 3000);

                    if (refreshInterval) clearInterval(refreshInterval);
                    refreshInterval = setInterval(() => {
                        if (currentUser) {
                            loadAllData(true); // silent: background refresh shouldn't blank the balance
                            loadScheduledMeeting();
                            loadMembersList();
                        }
                    }, 30000);
                } else {
                    // FIX: a transient server error (e.g. HTTP 502, already
                    // retried twice by callAPI before giving up) was
                    // displayed as raw text like "HTTP 502" or fell through
                    // to "Invalid email or password" — easy to mistake for
                    // a wrong password when it's actually just Apps Script
                    // being briefly unavailable. Distinguish the two cases
                    // clearly so people know to just try again rather than
                    // doubt their credentials.
                    const isServerError = res.error && /HTTP \d{3}/.test(res.error);
                    errorEl.textContent = isServerError
                        ? 'Server is taking a moment to respond. Please try again in a few seconds.'
                        : (res.error || 'Invalid email or password');
                    errorEl.style.display = 'block';
                    // Only clear the password on an actual credentials
                    // failure — on a server error the person typed it
                    // correctly, no reason to make them retype it.
                    if (!isServerError) {
                        document.getElementById('loginPassword').value = '';
                    }
                }
            } catch (e) {
                errorEl.textContent = 'Error connecting to server';
                errorEl.style.display = 'block';
            }

            showLoginLoading(false);
        }

        // ============================================================
        // COUNTDOWN TIMER
        // ============================================================
        function updateCountdowns() {
            const els = document.querySelectorAll('.countdown-timer[data-date]');
            const now = new Date();
            els.forEach(el => {
                const target = new Date(el.getAttribute('data-date'));
                const diff = target - now;
                if (diff <= 0) {
                    el.innerHTML = '🎉 Meeting is today!';
                    el.classList.add('urgent');
                } else {
                    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
                    const hours = Math.floor((diff % 86400000) / (1000 * 60 * 60));
                    const mins = Math.floor((diff % 3600000) / (1000 * 60));
                    if (days > 0) el.innerHTML = `📅 Countdown: ${days}d ${hours}h`;
                    else if (hours > 0) { el.innerHTML = `⏰ Countdown: ${hours}h ${mins}m`;
                        el.classList.add('urgent'); } else { el.innerHTML = `⏰ Countdown: ${mins}m`;
                        el.classList.add('urgent'); }
                }
            });
        }

        function startCountdown() {
            if (countdownInterval) clearInterval(countdownInterval);
            updateCountdowns();
            countdownInterval = setInterval(updateCountdowns, 60000);
        }

        // ============================================================
        // NEXT MEETING SCHEDULER
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
                                <div class="meeting-header">
                                    <span class="meeting-date">📅 ${escapeHtml(res.meeting.date)}</span>
                                </div>
                                <div class="meeting-section">
                                    <div class="meeting-section-title">📋 Agenda:</div>
                                    <div class="meeting-section-content">${escapeHtml(res.meeting.agenda || 'Not set')}</div>
                                </div>
                                <div class="meeting-section">
                                    <div class="meeting-section-title">📍 Venue:</div>
                                    <div class="meeting-section-content">${escapeHtml(res.meeting.venue || 'Not set')}</div>
                                </div>
                                <div class="countdown-timer" data-date="${res.meeting.date}">📅 Loading countdown...</div>
                                <div class="meeting-section" style="margin-top: 10px;">
                                    <div class="meeting-section-title">📅 Scheduled by:</div>
                                    <div class="meeting-section-content">${escapeHtml(res.meeting.scheduledBy || 'Unknown')}</div>
                                </div>
                                ${isTreasurer() ? `<button class="delete-meeting-btn" onclick="cancelScheduledMeeting()" style="margin-top: 10px;">🗑️ Cancel Schedule</button>` : ''}
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

        // Builds a modal with the exact field IDs scheduleNextMeeting()
        // already expects, so that function works completely unchanged.
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

        // Wraps scheduleNextMeeting() to also close its own modal on
        // success, since that function is shared and shouldn't assume
        // where its inputs live.
        async function scheduleNextMeetingAndClose() {
            await scheduleNextMeeting();
            // Only close if the call actually succeeded — a failed
            // attempt should leave the modal open so the date/agenda/venue
            // aren't lost and the person can retry or fix the error.
            const dateInput = document.getElementById('nextMeetingDate');
            if (dateInput && dateInput.value === '') {
                dateInput.closest('.modal')?.remove();
            }
        }

        // Builds a modal with the exact field IDs sendAnnouncement() already
        // expects, so that function works completely unchanged.
        // ============================================================
        // TRANSACTION EDITING
        // ============================================================
        function openEditTransactionModal(rowKey, type, currentAmount, currentMessage) {
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content">
                    <h3>✏️ Request Edit</h3>
                    <p style="font-size:12px; color:var(--ink-soft); margin-bottom:14px;">
                        Editing a <strong>${escapeHtml(type)}</strong> transaction.
                        The original will be removed and sent back to the treasurer for re-approval.
                    </p>
                    <div class="form-grid">
                        <div style="grid-column:span 2;">
                            <label>New Amount (KES)</label>
                            <input type="number" id="editTxnAmount" value="${currentAmount}" min="1">
                        </div>
                        <div style="grid-column:span 2;">
                            <label>Updated Message</label>
                            <input type="text" id="editTxnMessage" value="${escapeHtml(currentMessage)}" placeholder="e.g., Bank/Mpesa Message">
                        </div>
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
            if (!newAmount || Number(newAmount) <= 0) {
                showToast('Please enter a valid amount', 'error');
                return;
            }
            const res = await callAPI('requestTransactionEdit', {
                rowKey,
                member: currentUser,
                requestedBy: currentUser,
                newAmount: Number(newAmount),
                newMessage
            });
            if (res.success) {
                showToast('Edit request submitted! Awaiting treasurer approval.', 'success');
                document.querySelector('.modal .close-modal')?.closest('.modal')?.remove();
                // Close the history modal too since the row has been pulled
                // back to pending — refreshing it now would be confusing.
                document.querySelector('.history-modal')?.remove();
                await loadAllData(false, true);
            } else {
                showToast(res.error || 'Error submitting edit request', 'error');
            }
        }

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
            // sendAnnouncement() clears both fields on success — use that
            // as the signal to close, same pattern as the scheduling modal.
            if (titleInput && titleInput.value === '') {
                titleInput.closest('.modal')?.remove();
            }
        }

        async function scheduleNextMeeting() {
            const date = document.getElementById('nextMeetingDate').value;
            const agenda = document.getElementById('nextMeetingAgenda').value;
            const venue = document.getElementById('nextMeetingVenue').value;

            if (!date) {
                showToast('Please select a meeting date', 'error');
                return;
            }

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
            if (!confirm('Are you sure you want to cancel the scheduled meeting?')) return;
            const res = await callAPI('cancelScheduledMeeting');
            if (res.success) {
                showToast('Scheduled meeting cancelled', 'success');
                await loadScheduledMeeting();
            } else {
                showToast('Error cancelling meeting', 'error');
            }
        }

        // ============================================================
        // SEND ANNOUNCEMENT (push notification to all members)
        // ============================================================
        async function sendAnnouncement() {
            const titleInput = document.getElementById('announcementTitle').value.trim();
            const bodyInput = document.getElementById('announcementBody').value.trim();

            if (!bodyInput) {
                showToast('Please write a message before sending', 'error');
                return;
            }

            const btn = document.getElementById('sendAnnouncementBtn');
            const originalText = btn.innerHTML;
            showButtonLoading(btn, 'Sending...');

            // Prefix with sender name so recipients know who sent it
            const title = titleInput ? `📢 ${titleInput}` : `📢 Announcement from ${currentUser}`;
            const body = `${bodyInput} — sent by ${currentUser}`;

            const res = await callAPI('sendPushNotification', {
                title,
                body,
                sender: currentUser
            });

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
        // CHANGE PASSWORD
        // ============================================================
        function openChangePasswordModal() {
            document.querySelectorAll('.modal').forEach(el => el.remove());

            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                `<div class="modal-content"><h3>🔐 Change Password</h3><div style="margin-bottom:16px;"><label>Current Password</label><input type="password" id="currentPassword" class="pin-input-field" placeholder="Enter current password"></div><div style="margin-bottom:16px;"><label>New Password (min 6 characters)</label><input type="password" id="newPassword" class="pin-input-field" placeholder="Enter new password"></div><div style="margin-bottom:16px;"><label>Confirm New Password</label><input type="password" id="confirmPassword" class="pin-input-field" placeholder="Confirm new password"></div><div class="modal-buttons"><button onclick="changePassword()">Change Password</button><button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button></div></div>`;
            document.body.appendChild(modal);
            setTimeout(() => document.getElementById('currentPassword')?.focus(), 100);
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
                const res = await callAPI('changePassword', { email: currentUserEmail, oldPassword: cur,
                    newPassword: newPwd });
                if (res.success) {
                    showToast('Password changed! Please login again.', 'success');
                    document.querySelector('.modal')?.remove();
                    setTimeout(() => logout(), 2000);
                } else {
                    showToast(res.error || 'Failed', 'error');
                }
            } catch (e) { showToast('Error changing password', 'error'); } finally { hideButtonLoading(btn, orig); }
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

            const overlay = document.createElement('div');
            overlay.className = 'profile-modal-overlay';
            overlay.onclick = function(e) {
                if (e.target === this) this.remove();
            };

            overlay.innerHTML = `
                    <div class="profile-modal">
                        <div class="profile-cover">
                            <div class="profile-avatar-wrapper">
                                <div class="profile-avatar" id="profileAvatar" onclick="document.getElementById('profileFileInput').click()">
                                    ${profileImage ? `<img src="${profileImage}" alt="${currentUser}">` : initial}
                                    <div class="avatar-overlay">
                                        <span class="camera-icon">📷</span>
                                        <span>Change Photo</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                        <div class="profile-body">
                            <div class="profile-name">${escapeHtml(currentUser)}</div>
                            <div class="profile-email">${escapeHtml(currentUserEmail)}</div>
                            <span class="profile-role ${isTreas ? 'treasurer' : ''}">${isTreas ? '👑 Treasurer' : '👤 Member'}</span>
                            
                            <div class="profile-divider"></div>
                            
                            <div class="profile-stats-grid">
                                <div class="profile-stat-card savings">
                                    <div class="stat-number">KES ${userStats.savings.toLocaleString()}</div>
                                    <div class="stat-label">Total Savings</div>
                                </div>
                                <div class="profile-stat-card loans">
                                    <div class="stat-number">KES ${userStats.loans.toLocaleString()}</div>
                                    <div class="stat-label">Total Loans</div>
                                </div>
                                <div class="profile-stat-card repaid">
                                    <div class="stat-number">KES ${userStats.repaid.toLocaleString()}</div>
                                    <div class="stat-label">Total Repaid</div>
                                </div>
                                <div class="profile-stat-card net">
                                    <div class="stat-number">KES ${userStats.net.toLocaleString()}</div>
                                    <div class="stat-label">Net Balance</div>
                                </div>
                            </div>
                            
                            <div class="profile-divider"></div>
                            
                            <div class="profile-actions">
                                <button class="btn-change-pwd" onclick="openChangePasswordModal(); document.querySelector('.profile-modal-overlay')?.remove();">🔐 Change Password</button>
                                <button class="btn-close" onclick="this.closest('.profile-modal-overlay').remove()">Close</button>
                            </div>
                            
                            <div class="upload-progress" id="uploadProgress">
                                <span id="uploadStatus">Uploading...</span>
                                <div class="progress-bar">
                                    <div class="progress-fill" id="uploadProgressFill"></div>
                                </div>
                            </div>
                        </div>
                        <input type="file" id="profileFileInput" class="profile-file-input" accept="image/*" onchange="handleProfileImageUpload(event)">
                    </div>
                `;

            document.body.appendChild(overlay);
        }

        // ============================================================
        // PROFILE IMAGE UPLOAD
        // ============================================================
        async function handleProfileImageUpload(event) {
            const file = event.target.files[0];
            if (!file) return;

            if (!file.type.startsWith('image/')) {
                showToast('Please select an image file', 'error');
                return;
            }

            const progressEl = document.getElementById('uploadProgress');
            const progressFill = document.getElementById('uploadProgressFill');
            const statusEl = document.getElementById('uploadStatus');

            progressEl.classList.add('active');
            progressFill.style.width = '0%';
            statusEl.textContent = 'Reading image...';

            const reader = new FileReader();
            reader.onprogress = function(e) {
                if (e.lengthComputable) {
                    const percent = (e.loaded / e.total) * 50;
                    progressFill.style.width = percent + '%';
                }
            };

            reader.onload = function(e) {
                statusEl.textContent = 'Processing...';
                progressFill.style.width = '75%';

                const img = new Image();
                img.onload = async function() {
                    const canvas = document.createElement('canvas');
                    const maxSize = 120;
                    let width = img.width;
                    let height = img.height;

                    if (width > height) {
                        if (width > maxSize) {
                            height = (height * maxSize) / width;
                            width = maxSize;
                        }
                    } else {
                        if (height > maxSize) {
                            width = (width * maxSize) / height;
                            height = maxSize;
                        }
                    }

                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    const compressedData = canvas.toDataURL('image/jpeg', 0.6);

                    statusEl.textContent = 'Saving to server...';
                    progressFill.style.width = '90%';

                    const success = await saveProfileImageToServer(compressedData);

                    if (success) {
                        const avatar = document.getElementById('profileAvatar');
                        if (avatar) {
                            avatar.innerHTML =
                                `<img src="${compressedData}" alt="${currentUser}"><div class="avatar-overlay"><span class="camera-icon">📷</span><span>Change Photo</span></div>`;
                        }
                        progressFill.style.width = '100%';
                        statusEl.textContent = '✅ Done!';
                        setTimeout(() => {
                            progressEl.classList.remove('active');
                            progressFill.style.width = '0%';
                        }, 1500);
                        showToast('Profile photo updated successfully!', 'success');
                    } else {
                        statusEl.textContent = '❌ Failed to save';
                        showToast('Failed to save profile photo. Please try again.', 'error');
                    }
                };
                img.src = e.target.result;
            };

            reader.onerror = function() {
                showToast('Error reading image', 'error');
                progressEl.classList.remove('active');
            };

            reader.readAsDataURL(file);
            event.target.value = '';
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

        // ============================================================
        // ABOUT US / MEMBERS LIST
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
                    container.innerHTML =
                        '<div class="empty-state" style="grid-column: 1 / -1;">No members found. Please register users.</div>';
                    document.getElementById('memberCountBadge').textContent = '0 Members';
                }
                updateAboutStats();
            } catch (e) {
                container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">Error loading members</div>';
            }
        }

        // Populates the About page's stat strip (Members / Total Saved /
        // Transactions) from real data already loaded elsewhere in the app
        // — no invented numbers, just a glanceable summary instead of prose.
        function updateAboutStats() {
            const membersEl = document.getElementById('aboutStatMembers');
            const savingsEl = document.getElementById('aboutStatSavings');
            const txnsEl = document.getElementById('aboutStatTxns');
            if (membersEl) membersEl.textContent = allMembersData.length || 0;
            if (txnsEl) txnsEl.textContent = allRecords.length || 0;
            if (savingsEl) {
                const totalSaved = allRecords
                    .filter(r => r.type === 'Savings')
                    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
                savingsEl.textContent = totalSaved >= 1000
                    ? `${(totalSaved / 1000).toFixed(1)}K`
                    : totalSaved.toLocaleString('en-KE');
            }
        }

        function renderMembersList(members) {
            const container = document.getElementById('membersList');
            if (!container) return;

            if (!members || members.length === 0) {
                container.innerHTML = '<div class="empty-state" style="grid-column: 1 / -1;">No members found</div>';
                return;
            }

            const sortedMembers = [...members].sort((a, b) => a.name.localeCompare(b.name));

            container.innerHTML = sortedMembers.map(member => {
                const initial = getInitials(member.name);
                const isTreas = member.name === TREASURER_NAME;
                const memberStats = getUserStats(member.name);
                const cachedPhoto = memberPhotoCache[member.email?.toLowerCase()];
                // Show the cached photo immediately if we already have it
                // from a previous render this session; otherwise show
                // initials right away (no spinner/wait) and swap in the
                // real photo once it arrives, only for members who
                // actually have one (hasImage flag from the backend).
                const avatarContent = cachedPhoto
                    ? `<img src="${cachedPhoto}" alt="${escapeHtml(member.name)}">`
                    : initial;

                return `
                        <div class="member-card" onclick="viewMemberProfile('${escapeHtml(member.name)}', '${escapeHtml(member.email || '')}')">
                            <div class="member-avatar" id="memberAvatar-${escapeHtml(member.email || '')}">
                                ${avatarContent}
                            </div>
                            <div class="member-card-info">
                                <div class="member-name">${escapeHtml(member.name)}</div>
                                <div class="member-role ${isTreas ? 'treasurer' : ''}">${isTreas ? '👑 Treasurer' : 'Member'}</div>
                            </div>
                            <div class="member-stats">
                                <span>💰 KES ${(memberStats.savings || 0).toLocaleString()}</span>
                                <span>🏦 KES ${(memberStats.loans || 0).toLocaleString()}</span>
                            </div>
                        </div>
                    `;
            }).join('');

            // FIX (intermittent 502s): these were all firing in the same
            // instant via forEach — confirmed by Vercel logs showing 4-5
            // requests landing within ~50ms of each other, which was
            // triggering Apps Script's own throttling (it returns an HTML
            // interstitial page instead of JSON when overwhelmed by a
            // burst, which the proxy correctly reports as a 502). Staggering
            // each photo fetch by 200ms avoids presenting Google with a
            // simultaneous burst, even though it makes a multi-photo
            // member list take a little longer to fully populate.
            let photoFetchDelay = 0;
            sortedMembers.forEach(member => {
                if (!member.hasImage || !member.email) return;
                const emailKey = member.email.toLowerCase();
                if (memberPhotoCache[emailKey]) return; // already cached
                const email = member.email;
                setTimeout(() => loadMemberPhoto(email), photoFetchDelay);
                photoFetchDelay += 200;
            });
        }

        // Fetches one member's photo on demand and caches it for the rest
        // of the session, then swaps it into any visible avatar element
        // for that member. Never re-fetches a photo already in the cache.
        async function loadMemberPhoto(email) {
            try {
                const res = await callAPI('getProfileImage', { email });
                if (res.success && res.image) {
                    memberPhotoCache[email.toLowerCase()] = res.image;
                    const avatarEl = document.getElementById(`memberAvatar-${email}`);
                    if (avatarEl) {
                        avatarEl.innerHTML = `<img src="${res.image}" alt="${escapeHtml(email)}">`;
                    }
                }
            } catch (e) {
                // Silent failure is fine here — the member just keeps
                // showing their initials, which is a perfectly normal
                // fallback state, not an error worth surfacing.
                console.error('Failed to load photo for', email, e);
            }
        }

        function viewMemberProfile(name, email) {
            const member = allMembersData.find(m => m.name === name);
            if (!member) {
                showToast('Member not found', 'error');
                return;
            }

            const stats = getUserStats(name);
            const isTreas = name === TREASURER_NAME;
            const initial = getInitials(name);
            const cachedPhoto = email ? memberPhotoCache[email.toLowerCase()] : null;
            const avatarId = `profileViewAvatar-${email || name}`;

            const overlay = document.createElement('div');
            overlay.className = 'profile-modal-overlay';
            overlay.onclick = function(e) {
                if (e.target === this) this.remove();
            };

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
                                <div class="profile-stat-card savings">
                                    <div class="stat-number">KES ${(stats.savings || 0).toLocaleString()}</div>
                                    <div class="stat-label">Total Savings</div>
                                </div>
                                <div class="profile-stat-card loans">
                                    <div class="stat-number">KES ${(stats.loans || 0).toLocaleString()}</div>
                                    <div class="stat-label">Total Loans</div>
                                </div>
                                <div class="profile-stat-card repaid">
                                    <div class="stat-number">KES ${(stats.repaid || 0).toLocaleString()}</div>
                                    <div class="stat-label">Total Repaid</div>
                                </div>
                                <div class="profile-stat-card net">
                                    <div class="stat-number">KES ${(stats.net || 0).toLocaleString()}</div>
                                    <div class="stat-label">Net Balance</div>
                                </div>
                            </div>
                            
                            <div class="profile-divider"></div>
                            
                            <div class="profile-actions">
                                <button class="btn-close" onclick="this.closest('.profile-modal-overlay').remove()">Close</button>
                            </div>
                        </div>
                    </div>
                `;

            document.body.appendChild(overlay);

            // If this member has a photo (per the lightweight hasImage
            // flag) but it isn't cached yet, fetch it now and swap it
            // into this modal's avatar once it arrives.
            if (member.hasImage && email && !cachedPhoto) {
                const emailKey = email.toLowerCase();
                callAPI('getProfileImage', { email }).then(res => {
                    if (res.success && res.image) {
                        memberPhotoCache[emailKey] = res.image;
                        const avatarEl = document.getElementById(avatarId);
                        if (avatarEl) {
                            avatarEl.innerHTML = `<img src="${res.image}" alt="${escapeHtml(name)}">`;
                        }
                    }
                }).catch(e => console.error('Failed to load photo for', email, e));
            }
        }

        // ============================================================
        // HISTORY MODAL
        // ============================================================
        let currentHistoryRecords = [];

        function openHistoryModal() {
            const modal = document.createElement('div');
            modal.className = 'history-modal';
            modal.innerHTML =
                `<div class="history-modal-content"><div class="history-modal-header"><h3>📜 Transaction History</h3><button class="close-history-btn" onclick="this.closest('.history-modal').remove()">✕</button></div><div class="history-modal-body"><div class="history-search"><input type="text" id="historySearch" placeholder="Search..."><select id="historyFilterMember"><option value="">All Members</option>${allMembers.map(m => `<option value="${m}">${m}</option>`).join('')}</select><select id="historyFilterType"><option value="">All Types</option><option value="Savings">Savings</option><option value="Loan Taken">Loan Taken</option><option value="Loan Repayment">Loan Repayment</option></select></div><div style="overflow-x: auto; max-width: 100%;"><table class="history-table"><thead><tr><th onclick="sortHistory('date')">Date ⬍</th><th onclick="sortHistory('member')">Member ⬍</th><th onclick="sortHistory('type')">Type ⬍</th><th onclick="sortHistory('amount')">Amount ⬍</th><th>Message</th><th></th></tr></thead><tbody id="historyBody"></tbody></table></div></div></div>`;
            document.body.appendChild(modal);
            currentHistoryRecords = [...allRecords];
            renderHistoryTable();
            document.getElementById('historySearch')?.addEventListener('input', () => filterHistory());
            document.getElementById('historyFilterMember')?.addEventListener('change', () => filterHistory());
            document.getElementById('historyFilterType')?.addEventListener('change', () => filterHistory());
        }

        function filterHistory() {
            const search = document.getElementById('historySearch')?.value.toLowerCase() || '';
            const filterMember = document.getElementById('historyFilterMember')?.value || '';
            const filterType = document.getElementById('historyFilterType')?.value || '';
            let filtered = [...allRecords];
            if (filterMember) filtered = filtered.filter(r => r.member === filterMember);
            if (filterType) filtered = filtered.filter(r => r.type === filterType);
            if (search) filtered = filtered.filter(r => r.member.toLowerCase().includes(search) || (r.message || '')
                .toLowerCase().includes(search));
            renderHistoryTable(filtered);
        }

        function sortHistory(column) { renderHistoryTable(); }

        function renderHistoryTable(filtered = null) {
            const tbody = document.getElementById('historyBody');
            if (!tbody) return;
            const records = filtered || currentHistoryRecords;
            if (!records.length) { tbody.innerHTML =
                '<tr><td colspan="6" class="empty-state">No transactions found</td></tr>'; return; }
            tbody.innerHTML = records.map(r => {
                let cls = r.type === 'Savings' ? 'badge-savings' : (r.type === 'Loan Taken' ? 'badge-loan' :
                    'badge-repayment');
                let sign = r.type === 'Loan Repayment' ? '+' : (r.type === 'Savings' ? '+' : '-');
                let msg = createMessageWithReadMore(r.message || '-', 50);
                // Build a row key the backend uses to locate this exact
                // transaction (date|member|type|amount). Only show the
                // Edit button for the logged-in member's own rows.
                const rowKey = `${r.date}|${r.member}|${r.type}|${r.amount}`;
                const isOwn = r.member === currentUser;
                const editBtn = isOwn
                    ? `<button class="edit-txn-btn" onclick="openEditTransactionModal(${JSON.stringify(rowKey)}, ${JSON.stringify(r.type)}, ${r.amount}, ${JSON.stringify(r.message || '')})">✏️ Edit</button>`
                    : '';
                return `<tr>
                    <td style="white-space: nowrap;">${new Date(r.date).toLocaleDateString('en-KE')}</td>
                    <td><strong>${escapeHtml(r.member)}</strong></td>
                    <td><span class="badge ${cls}">${r.type}</span></td>
                    <td style="white-space: nowrap;">${sign} KES ${(r.amount || 0).toLocaleString('en-KE')}</td>
                    <td class="message-cell">${msg}</td>
                    <td>${editBtn}</td>
                </tr>`;
            }).join('');
        }

        function createMessageWithReadMore(msg, maxLen = 60) {
            if (!msg) return '-';
            if (msg.length <= maxLen) return escapeHtml(msg);
            const truncated = escapeHtml(msg.substring(0, maxLen)) + '...';
            const full = escapeHtml(msg);
            const id = 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
            return `<span id="${id}" class="message-text truncated">${truncated}</span><button class="read-more-btn" onclick="toggleReadMore('${id}', '${full.replace(/'/g, "\\'")}', '${truncated.replace(/'/g, "\\'")}')">Read more</button>`;
        }

        function toggleReadMore(id, full, truncated) {
            const el = document.getElementById(id);
            const btn = el.nextElementSibling;
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

        function showBalanceLoading(show) {
            const savings = document.getElementById('totalSavingsTop');
            const loans = document.getElementById('outstandingTop');
            if (savings) savings.classList.toggle('is-loading', show);
            if (loans) loans.classList.toggle('is-loading', show);
        }

        // FIX (intermittent 502s): Apps Script occasionally returns an
        // HTML interstitial page instead of JSON when hit with a burst of
        // simultaneous requests (confirmed via Vercel logs — the proxy
        // correctly reports this as a 502 with "Non-JSON response from
        // Apps Script"). Staggering request bursts (see loadMemberPhoto
        // call sites) reduces how often this happens, but as a safety
        // net, callAPI now retries once automatically on a 502 before
        // giving up — a brief pause then retry is usually enough since
        // these are transient, not persistent, failures.
        // FIX (occasional solitary 502s, e.g. on login): a single retry
        // after a fixed 800ms wasn't always enough — confirmed by a 502
        // on the LOGIN request itself (no burst of other calls involved
        // at all, so this isn't the "too many simultaneous requests"
        // cause we fixed elsewhere; it's just Apps Script's own
        // occasional transient unavailability). Now retries up to twice
        // with increasing backoff (800ms, then 1.6s) before giving up —
        // gives a brief Google-side hiccup more room to clear, while
        // still failing within ~2.5s total if something is genuinely
        // broken rather than leaving someone stuck indefinitely.
        async function callAPI(action, data = {}, _retryCount = 0) {
            const MAX_RETRIES = 2;
            try {
                const params = new URLSearchParams({ action, ...data });
                const url = `${API_URL}?${params.toString()}`;
                const response = await fetch(url);
                if (!response.ok) {
                    if (response.status === 502 && _retryCount < MAX_RETRIES) {
                        const backoffMs = 800 * Math.pow(2, _retryCount); // 800ms, then 1600ms
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
        // MEETING MINUTES
        // ============================================================
        async function loadMeetingMinutes() {
            const container = document.getElementById('meetingMinutesList');
            if (!container) return;
            container.innerHTML =
                '<div class="loading-container"><div class="loading-spinner"></div><div>Loading meetings...</div></div>';
            const res = await callAPI('getMeetingMinutes');
            if (res.success && res.meetings) {
                const meetings = res.meetings;
                if (meetings.length === 0) {
                    container.innerHTML =
                        '<div class="empty-state">No meeting minutes recorded yet. Click "Add Meeting" to get started.</div>';
                    return;
                }
                container.innerHTML = meetings.slice().reverse().map(meeting => {
                    let countdownHtml = '';
                    if (meeting.nextMeeting && meeting.nextMeeting !== '') {
                        countdownHtml = `<div class="countdown-timer" data-date="${meeting.nextMeeting}">📅 Loading countdown...</div>`;
                    }
                    return `<div class="meeting-item"><div class="meeting-header"><span class="meeting-date">📅 ${escapeHtml(meeting.date)}</span><span class="meeting-author">by ${escapeHtml(meeting.recordedBy)}</span></div><div class="meeting-section"><div class="meeting-section-title">📋 Agenda:</div><div class="meeting-section-content">${escapeHtml(meeting.agenda)}</div></div><div class="meeting-section"><div class="meeting-section-title">📝 Notes:</div><div class="meeting-section-content">${escapeHtml(meeting.notes || 'No notes')}</div></div><div class="meeting-section"><div class="meeting-section-title">✅ Decisions:</div><div class="meeting-section-content">${escapeHtml(meeting.decisions || 'None')}</div></div>${meeting.nextMeeting ? `<div class="meeting-section"><div class="meeting-section-title">📅 Next Meeting:</div><div class="meeting-section-content">${escapeHtml(meeting.nextMeeting)}</div>${countdownHtml}</div>` : ''}${isTreasurer() ? `<button class="delete-meeting-btn" onclick="deleteMeeting('${meeting.id}')">🗑️ Delete Meeting</button>` : ''}</div>`;
                }).join('');
                updateCountdowns();
                startCountdown();
            } else { container.innerHTML = '<div class="empty-state">Error loading meetings</div>'; }
        }

        async function deleteMeeting(id) {
            if (!confirm('Delete this meeting?')) return;
            const res = await callAPI('deleteMeeting', { id });
            if (res.success) { showToast('Meeting deleted!', 'success');
                await loadMeetingMinutes(); } else showToast('Error deleting meeting', 'error');
        }

        // Opens a modal containing the actual meeting-minutes list. The list
        // only renders once this modal (and its #meetingMinutesList target)
        // exists in the DOM — loadMeetingMinutes() is called fresh each time
        // so the data is current, not stale from a previous open.
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

        // ============================================================
        // AUDIT TRAIL — chronological activity feed (logins, profile
        // changes, password resets, submissions, approvals, rejections,
        // loan due-date setting), visible to everyone, opened from the
        // Meetings page.
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
                const whenStr = when && !isNaN(when)
                    ? when.toLocaleString('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                    : '';
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

        function openAddMeetingModal() {
            const today = new Date().toISOString().split('T')[0];
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML =
                `<div class="modal-content"><h3>📝 Add Meeting Minutes</h3><div class="form-grid"><div><label>Meeting Date</label><input type="date" id="meetingDate" value="${today}"></div><div><label>Recorded By</label><input type="text" id="meetingRecordedBy" value="${currentUser}" readonly></div><div style="grid-column: span 2;"><label>Agenda *</label><textarea id="meetingAgenda" rows="2"></textarea></div><div style="grid-column: span 2;"><label>Notes</label><textarea id="meetingNotes" rows="3"></textarea></div><div style="grid-column: span 2;"><label>Decisions Made</label><textarea id="meetingDecisions" rows="2"></textarea></div><div><label>Next Meeting Date</label><input type="date" id="meetingNext"></div></div><div class="modal-buttons"><button onclick="saveMeetingMinutes()">Save</button><button class="close-modal" onclick="this.closest('.modal').remove()">Cancel</button></div></div>`;
            document.body.appendChild(modal);
        }

        async function saveMeetingMinutes() {
            const date = document.getElementById('meetingDate').value;
            const agenda = document.getElementById('meetingAgenda').value.trim();
            if (!date || !agenda) { showToast('Please fill required fields', 'error'); return; }
            const res = await callAPI('saveMeetingMinutes', { date, recordedBy: currentUser, agenda,
                notes: document.getElementById('meetingNotes').value, decisions: document.getElementById(
                    'meetingDecisions').value, nextMeeting: document.getElementById('meetingNext').value });
            if (res.success) { showToast('Meeting saved!', 'success');
                // FIX: was document.querySelector('.modal')?.remove(), which
                // always removes the FIRST .modal in document order — wrong
                // when this Add-Meeting modal is stacked on top of an
                // already-open View-Minutes modal. Close specifically the
                // modal that contains this form (identified by its date
                // input) instead.
                document.getElementById('meetingDate')?.closest('.modal')?.remove();
                await loadMeetingMinutes(); } else showToast('Error: ' + res.error, 'error');
        }

        async function cancelLoanRequest(loanId) {
            if (!confirm('Cancel this loan request?')) return;
            const btn = event.target;
            const orig = btn.innerHTML;
            showButtonLoading(btn, 'Cancelling...');
            const res = await callAPI('cancelLoan', { loanId });
            if (res.success) { showToast('Loan cancelled!', 'success');
                await loadAllData(); } else showToast(res.error || 'Error', 'error');
            hideButtonLoading(btn, orig);
        }

        // ============================================================
        // CHART FUNCTION
        // ============================================================
        function renderChart(summary) {
            const canvas = document.getElementById('financialChart');
            if (!canvas) return;

            const savings = summary.savings || 0;
            const loans = summary.loansTaken || 0;
            const repaid = summary.repaid || 0;
            const net = savings - loans + repaid;

            // FIX (Available Balance bug + interest tracking): show the
            // corrected Available Balance (savings minus outstanding
            // principal — what's actually free to lend) alongside
            // Outstanding Principal and Interest Earned, tracked as its
            // own separate figure rather than hidden inside repayment
            // totals.
            const availableEl = document.getElementById('summaryStatAvailable');
            const outstandingEl = document.getElementById('summaryStatOutstanding');
            const interestEl = document.getElementById('summaryStatInterest');
            if (availableEl) availableEl.textContent = `KES ${savings.toLocaleString('en-KE')}`;
            if (outstandingEl) outstandingEl.textContent = `KES ${(summary.outstanding || 0).toLocaleString('en-KE')}`;
            if (interestEl) interestEl.textContent = `KES ${(summary.interestEarned || 0).toLocaleString('en-KE')}`;

            if (chartInstance) {
                chartInstance.destroy();
                chartInstance = null;
            }

            const ctx = canvas.getContext('2d');
            const total = savings + loans + repaid;

            // Donut chart: Savings / Loans / Repaid as slices (the three real,
            // independent money movements), with Net shown as a center label
            // instead of a fourth slice — Net is a derived value (Savings -
            // Loans + Repaid), not an independent share, so it can't honestly
            // be a slice of the same pie.
            const centerTextPlugin = {
                id: 'centerText',
                afterDraw(chart) {
                    const { ctx, chartArea } = chart;
                    if (!chartArea) return;
                    const cx = (chartArea.left + chartArea.right) / 2;
                    const cy = (chartArea.top + chartArea.bottom) / 2;
                    ctx.save();
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
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
                        backgroundColor: [
                            'rgba(20, 33, 61, 0.85)',
                            'rgba(59, 111, 242, 0.9)',
                            'rgba(20, 33, 61, 0.3)'
                        ],
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
                            labels: {
                                boxWidth: 12,
                                boxHeight: 12,
                                padding: 14,
                                font: { size: window.innerWidth < 500 ? 10 : 12, weight: '600' },
                                color: '#7C8AA5'
                            }
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
                    animation: {
                        duration: 1000,
                        easing: 'easeOutQuart'
                    }
                }
            });
        }

        // ============================================================
        // LOAD ALL DATA
        // ============================================================
        // FIX (UX): the 30-second background auto-refresh was calling
        // loadAllData() with no way to distinguish "person just switched
        // tabs and is waiting" from "quietly refreshing in the
        // background while they're already looking at the screen." Both
        // cases triggered showBalanceLoading(true), which blanks the
        // balance text out — jarring when nothing the person did caused
        // it. silent=true (used only by the background timer) skips that
        // visual interruption; the numbers update in place via the
        // existing count-up animation instead of flashing to blank first.
        // FIX (never want to see the balance "load" from my own taps):
        // switching to ANY other tab (Loans, Meetings, Summary, etc.)
        // still calls loadAllData() to keep that tab's own data current
        // — but it was also re-running the balance shimmer + count-up
        // animation every time, even though the person isn't even
        // looking at Home. skipBalanceUI=true updates the underlying
        // data silently (so it's correct whenever they DO return to
        // Home) without touching the visible balance card at all. Only
        // the 30-second background timer and actions that directly
        // affect the balance (deposits, loans, repayments) are allowed
        // to visibly update it.
        async function loadAllData(silent = false, skipBalanceUI = false) {
            if (isLoading || !currentUser) return;
            isLoading = true;
            if (!silent && !skipBalanceUI) showBalanceLoading(true);
            try {
                // FIX (performance): was 5 separate Apps Script HTTP round-trips
                // on every load AND every tab switch — several of which
                // redundantly re-read the same sheets (Transactions read
                // twice, Users read twice). Now a single combined call does
                // every read exactly once on the backend and returns it all
                // together, cutting both the number of round-trips and the
                // actual Sheets API work in half or more.
                const dash = await callAPI('getDashboardData', {
                    includePending: isTreasurer() ? 'true' : 'false',
                    isTreasurer: isTreasurer() ? 'true' : 'false',
                    // FIX (performance regression): ActiveLoans/LoansAwaitingDueDate
                    // were being read on EVERY refresh including the silent
                    // 30-second background timer, adding 1-2 extra full-sheet
                    // reads to a call that's already doing 5-6 others. Loan
                    // balances don't change every 30 seconds — they only
                    // change when a loan/repayment is actually
                    // submitted/approved, which already triggers its own
                    // explicit (non-silent) loadAllData() call. Skipping
                    // these two reads specifically on silent refreshes
                    // cuts real, unnecessary backend work.
                    includeLoanTracking: silent ? 'false' : 'true'
                });

                if (!dash.success) throw new Error(dash.error || 'Failed to load dashboard data');

                allRecords = dash.records || [];
                applyFilters();
                updateAboutStats();
                renderRecentActivity();

                if (dash.members?.length) {
                    allMembers = dash.members;
                    updateMemberDropdowns();
                }

                // FIX: renderWalletBalance() was previously called before
                // updateBalanceDisplays() ran, so it rendered using the
                // PREVIOUS summary instead of the one just fetched. Now
                // updateBalanceDisplays() (which sets lastGroupSummary AND
                // re-renders) runs first, and the explicit renderWalletBalance()
                // call below only matters for the 'mine' scope, which depends
                // on allRecords rather than dash.summary.
                //
                // skipBalanceUI: still cache the fetched summary (so it's
                // correct when the person eventually returns to Home) but
                // skip the actual visible shimmer/count-up/chart re-render.
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
                pendingLoans = allLoans.filter(l => l.approvals.length < (total - 1) && l.status !== 'completed' && l
                    .status !== 'rejected');
                completedLoans = allLoans.filter(l => l.approvals.length >= (total - 1) || l.status === 'completed');
                renderPendingLoans();
                renderCompletedLoans();

                // Loan repayment scheduling feature: active loans (with
                // remaining balance / due date / overdue status) and, for
                // the treasurer, loans fully approved but still awaiting
                // a due date to be set. On silent background refreshes the
                // backend intentionally skips these reads (see
                // includeLoanTracking above) — only update this state when
                // the backend actually sent it, so a silent refresh doesn't
                // wipe the previously-loaded loan data back to empty.
                if (dash.activeLoans !== undefined) {
                    activeLoans = dash.activeLoans || [];
                    if (!skipBalanceUI) renderActiveLoans();
                }
                if (isTreasurer() && dash.loansAwaitingDueDate !== undefined) {
                    loansAwaitingDueDate = dash.loansAwaitingDueDate || [];
                    if (!skipBalanceUI) renderLoansAwaitingDueDate();
                }

                if (isTreasurer()) {
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
                // Safety net: if the summary fetch itself failed or never
                // resolved (e.g. network error), make sure the shimmer
                // doesn't get stuck on indefinitely.
                showBalanceLoading(false);
            }
        }

        // ============================================================
        // COUNT-UP ANIMATION
        // Animates a number from its previous displayed value up (or
        // down) to a new target, rather than snapping instantly — gives
        // the wallet balance a sense of being "live" money rather than
        // a static label that just changes.
        // ============================================================
        function animateCountUp(el, newValue, prefix = 'KES ') {
            if (!el) return;
            const prevTarget = Number(el.getAttribute('data-target') || 0);
            const target = Number(newValue) || 0;
            el.setAttribute('data-target', target);

            // Respect users who've asked for reduced motion: just set the
            // final value instantly rather than animating.
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
                // easeOutQuart — fast start, gentle settle, matches the
                // chart animations elsewhere in the app for consistency.
                const eased = 1 - Math.pow(1 - progress, 4);
                const current = Math.round(from + (target - from) * eased);
                el.innerHTML = `${prefix}${current.toLocaleString('en-KE')}`;
                if (progress < 1) requestAnimationFrame(tick);
            }
            requestAnimationFrame(tick);
        }

        // Mine/Group balance scope toggle. 'group' shows the whole
        // group's pooled savings/outstanding loans (the original
        // behavior); 'mine' shows just the logged-in member's own
        // savings/loans via getUserStats(). lastGroupSummary is cached
        // so switching scope is instant — no extra fetch needed.
        let walletScope = 'group';
        let lastGroupSummary = null;

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

        function toggleWalletScopeMenu() {
            const menu = document.getElementById('walletScopeMenu');
            if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
        }

        function setWalletScope(scope) {
            walletScope = scope;
            const label = document.getElementById('walletScopeLabel');
            if (label) label.textContent = scope === 'mine' ? '👤 Mine' : '🧺 Group';
            const menu = document.getElementById('walletScopeMenu');
            if (menu) menu.style.display = 'none';
            renderWalletBalance();
        }

        // Close the scope dropdown when tapping anywhere outside it.
        document.addEventListener('click', (e) => {
            const wrapper = document.getElementById('walletScopeChip')?.closest('.wallet-scope-wrapper');
            const menu = document.getElementById('walletScopeMenu');
            if (wrapper && menu && menu.style.display !== 'none' && !wrapper.contains(e.target)) {
                menu.style.display = 'none';
            }
        });

        function renderPendingLoans() {
            const container = document.getElementById('pendingLoans');
            if (!container) return;
            if (!pendingLoans.length) { container.innerHTML = '<div class="empty-state">No pending loan approvals</div>';
                return; }
            container.innerHTML = pendingLoans.map(loan => {
                const isRequester = (loan.member === currentUser);
                const alreadyApproved = loan.approvals.includes(currentUser);
                const showButtons = !isRequester && !alreadyApproved;
                const totalNeeded = Math.max(allMembers.length - 1, 1);
                const percent = totalNeeded > 0 ? (loan.approvals.length / totalNeeded) * 100 : 100;
                return `<div class="loan-item ${isRequester ? 'own-loan' : ''}"><div><strong>${escapeHtml(loan.member)}</strong> requested <strong>KES ${(loan.principal || 0).toLocaleString('en-KE')}</strong> + 10% interest = <strong>KES ${(loan.totalDue || 0).toLocaleString('en-KE')}</strong>${isRequester ? ' (Your request - cannot approve)' : (alreadyApproved ? ' (You approved)' : '')}</div><div style="font-size:12px;">${escapeHtml(loan.message || '')}</div><div style="font-size:11px; margin-top:5px;">Approvals: ${loan.approvals.length}/${totalNeeded}</div><div class="progress-bar"><div class="progress-fill" style="width: ${Math.min(percent, 100)}%;"></div></div>${showButtons ? `<div style="margin-top:8px; display:flex; gap:8px;"><button class="approve-btn" onclick="approveLoan('${loan.id}')">Approve</button><button class="reject-btn" onclick="rejectLoan('${loan.id}')">Reject</button></div>` : ''}${isRequester && loan.status === 'pending' ? `<div style="margin-top:8px;"><button class="cancel-btn" onclick="cancelLoanRequest('${loan.id}')">❌ Cancel Request</button></div>` : ''}</div>`;
            }).join('');
        }

        function renderCompletedLoans() {
            const container = document.getElementById('completedLoans');
            if (!container) return;
            if (!completedLoans.length) { container.innerHTML = '<div class="empty-state">No completed loans yet</div>';
                return; }
            container.innerHTML = completedLoans.map(loan =>
                `<div class="completed-loan-item"><div><strong>${escapeHtml(loan.member)}</strong> borrowed <strong>KES ${(loan.principal || 0).toLocaleString('en-KE')}</strong></div><div>Interest: KES ${(loan.interest || 0).toLocaleString('en-KE')}</div><div><strong>Total Due: KES ${(loan.totalDue || 0).toLocaleString('en-KE')}</strong></div><div style="font-size:10px;">Approved by: ${escapeHtml(loan.approvals.join(', '))}</div><div>${escapeHtml(loan.message || '')}</div></div>`
                ).join('');
        }

        // ============================================================
        // LOAN REPAYMENT SCHEDULING
        // ============================================================
        // Active loans with remaining balance / due date / overdue status
        // — shows everyone's active loans (own loans highlighted), so the
        // group can see who owes what and whether anything is overdue.
        function renderActiveLoans() {
            const container = document.getElementById('activeLoansList');
            if (!container) return;
            const stillOwed = activeLoans.filter(l => l.status !== 'paid_off');
            if (!stillOwed.length) {
                container.innerHTML = '<div class="empty-state">No active loans right now</div>';
                return;
            }
            container.innerHTML = stillOwed.map(loan => {
                const isMine = loan.member === currentUser;
                const overdueClass = loan.isOverdue ? 'loan-overdue' : '';
                const progressPct = loan.totalDue > 0 ? Math.min(100, (loan.amountRepaid / loan.totalDue) * 100) : 0;
                return `<div class="active-loan-item ${overdueClass} ${isMine ? 'own-loan' : ''}">
                    <div class="active-loan-header">
                        <strong>${escapeHtml(loan.member)}</strong>
                        ${loan.isOverdue ? '<span class="overdue-badge">⚠️ Overdue</span>' : ''}
                    </div>
                    <div class="active-loan-amounts">
                        <span>Owed: KES ${loan.remaining.toLocaleString('en-KE')}</span>
                        <span class="active-loan-total">of KES ${loan.totalDue.toLocaleString('en-KE')}</span>
                    </div>
                    <div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%;"></div></div>
                    <div class="active-loan-due">📅 Due: ${loan.dueDate || 'Not set'}</div>
                </div>`;
            }).join('');
        }

        // Treasurer-only: loans fully approved by all members but still
        // waiting for a due date to be set, which is what actually
        // activates them.
        function renderLoansAwaitingDueDate() {
            const container = document.getElementById('awaitingDueDateList');
            const card = document.getElementById('awaitingDueDateCard');
            if (!container) return;
            if (card) card.style.display = isTreasurer() ? 'block' : 'none';
            if (!isTreasurer()) return;
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

        function renderPendingApprovals() {
            const container = document.getElementById('pendingApprovalsList');
            if (!container) return;
            if (!pendingTransactions.length) { container.innerHTML = '<div class="empty-state">No pending approvals</div>';
                return; }
            container.innerHTML = pendingTransactions.map(t => {
                // Check if this pending transaction is actually an edit
                // request — identified by looking up member+type+amount
                // in the pendingEditsMap sent from the backend.
                const editKey = `${t.member}|${t.type}|${t.amount}`;
                const editInfo = pendingEditsMap[editKey];
                const editBadge = editInfo
                    ? `<div style="background:var(--blue-soft);color:var(--blue);border-radius:8px;padding:4px 10px;font-size:11px;font-weight:700;margin-bottom:8px;display:inline-block;">✏️ EDIT REQUEST — was KES ${editInfo.originalAmount.toLocaleString('en-KE')}: "${escapeHtml(editInfo.originalMessage)}"</div><br>`
                    : '';
                const rejectFn = editInfo
                    ? `rejectTransactionEdit('${editInfo.editId}', '${currentUser}')`
                    : `rejectTransaction('${t.id}')`;
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

        async function approveTransaction(id) {
            const btn = event.target;
            const orig = btn.innerHTML;
            showButtonLoading(btn, 'Approving...');
            const res = await callAPI('approveTransaction', { id, approvedBy: currentUser });
            if (res.success) { showToast('Transaction approved!', 'success');
                await loadAllData(); } else { showToast(res.error || 'Error', 'error'); }
            hideButtonLoading(btn, orig);
        }

        async function rejectTransaction(id) {
            const btn = event.target;
            const orig = btn.innerHTML;
            showButtonLoading(btn, 'Rejecting...');
            const res = await callAPI('rejectTransaction', { id });
            if (res.success) { showToast('Transaction rejected', 'success');
                await loadAllData(); } else { showToast(res.error || 'Error', 'error'); }
            hideButtonLoading(btn, orig);
        }

        async function rejectTransactionEdit(editId, rejectedBy) {
            const btn = event?.target;
            const orig = btn?.innerHTML;
            if (btn) showButtonLoading(btn, 'Rejecting...');
            const res = await callAPI('rejectTransactionEdit', { editId, rejectedBy: currentUser });
            if (res.success) {
                showToast('Edit request rejected — original transaction restored', 'success');
                await loadAllData();
            } else {
                showToast(res.error || 'Error rejecting edit', 'error');
            }
            if (btn) hideButtonLoading(btn, orig);
        }

        function updateMemberDropdowns() {
            const memberSelect = document.getElementById('memberSelect');
            const filterMember = document.getElementById('filterMember');
            if (memberSelect) {
                memberSelect.innerHTML = `<option value="${currentUser}">${escapeHtml(currentUser)}</option>`;
                memberSelect.disabled = true;
                memberSelect.style.background = '#F4F6FB';
            }
            if (filterMember) {
                filterMember.innerHTML = '<option value="">All Members</option>' + allMembers.map(m =>
                    `<option value="${m}">${escapeHtml(m)}</option>`).join('');
            }
        }

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
            if (res.success) { showToast('Loan rejected', 'success');
                await loadAllData(); } else showToast('Error: ' + res.error, 'error');
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
                if (amount > currentSavings) { showToast(
                        `Cannot borrow KES ${amount.toLocaleString()}. Available: KES ${currentSavings.toLocaleString()}`,
                        'error');
                    hideButtonLoading(btn, orig); return; }
                const res = await callAPI('submitLoan', { date, member, amount, message, notes: '',
                    requestedBy: currentUser });
                if (res.success) { showToast(
                        `Loan request submitted! Needs ${Math.max(allMembers.length - 1, 1)} other approvals.`,
                        'success');
                    document.getElementById('amount').value = '';
                    document.getElementById('message').value = '';
                    closeAddTransactionModal();
                    await loadAllData(); } else showToast('Error: ' + res.error, 'error');
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
                const res = await callAPI('submitTransaction', { date, member, type, amount, message,
                    submittedBy: currentUser, loanId });
                if (res.success) { showToast(`Transaction submitted! Waiting for ${TREASURER_NAME} approval.`,
                    'success');
                    document.getElementById('amount').value = '';
                    document.getElementById('message').value = '';
                    closeAddTransactionModal();
                    await loadAllData(); } else showToast('Error: ' + (res.error || 'Failed'), 'error');
            }
            hideButtonLoading(btn, orig);
        }

        function toggleApprovalNotice() {
            const notice = document.getElementById('approvalNotice');
            const type = document.getElementById('type').value;
            if (notice) notice.style.display = type === 'Loan Taken' ? 'block' : 'none';

            // Loan repayment scheduling feature: when repaying, show a
            // dropdown of the member's own ACTIVE loans (not paid off)
            // so they pick which specific loan they're paying toward —
            // any amount is allowed, including partial payments.
            const pickerWrapper = document.getElementById('repayLoanPickerWrapper');
            const amountHint = document.getElementById('amountHint');
            if (pickerWrapper) {
                pickerWrapper.style.display = type === 'Loan Repayment' ? 'block' : 'none';
                if (type === 'Loan Repayment') {
                    populateRepayLoanPicker();
                    if (amountHint) amountHint.textContent = 'You can pay any amount — partial payments are fine.';
                } else if (amountHint) {
                    amountHint.textContent = 'For loans: Enter PRINCIPAL amount (10% interest will be added)';
                }
            }
        }

        // Populates the repayment loan picker with the logged-in member's
        // own active (not yet paid off) loans, showing remaining balance
        // and due date so they can tell loans apart at a glance.
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

        // ============================================================
        // ADD TRANSACTION MODAL
        // Opened from the Home dashboard's quick-action icons
        // (Deposit / Loan / Repay) instead of a permanently visible
        // inline form.
        // ============================================================
        const TRANSACTION_MODAL_TITLES = {
            'Savings': '💰 New Deposit',
            'Loan Taken': '🏦 Request a Loan',
            'Loan Repayment': '🔄 Repay a Loan'
        };

        function openAddTransactionModal(type) {
            const modal = document.getElementById('addTransactionModal');
            if (!modal) return;
            document.getElementById('type').value = type;
            document.getElementById('addTransactionTitle').textContent = TRANSACTION_MODAL_TITLES[type] || '💰 New Transaction';
            toggleApprovalNotice();
            if (!document.getElementById('date').value) {
                document.getElementById('date').value = new Date().toISOString().split('T')[0];
            }
            modal.style.display = 'flex';
        }

        function closeAddTransactionModal() {
            const modal = document.getElementById('addTransactionModal');
            if (modal) modal.style.display = 'none';
        }

        // ============================================================
        // HOME DASHBOARD
        // ============================================================
        function updateDashboardGreeting() {
            const el = document.getElementById('dashboardGreeting');
            if (!el || !currentUser) return;
            const hour = new Date().getHours();
            const timeGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
            el.textContent = `👋 ${timeGreeting}, ${currentUser.split(' ')[0]}`;
        }

        function renderRecentActivity() {
            const container = document.getElementById('recentActivityList');
            if (!container) return;
            if (!allRecords.length) {
                container.innerHTML = '<div class="empty-state">No transactions yet — tap a quick action above to get started</div>';
                return;
            }
            const recent = [...allRecords]
                .sort((a, b) => new Date(b.date) - new Date(a.date))
                .slice(0, 5);
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

        // ============================================================
        // GROUP MEMORIES CAROUSEL
        // Edit GROUP_MEMORY_PHOTOS below to add real trip photos (e.g.
        // Oloolua Forest visit). Each entry needs a direct image URL.
        // Leave the array empty to keep the card hidden until photos
        // are added — it never shows broken placeholders.
        // ============================================================
        const GROUP_MEMORY_PHOTOS = [
            // { url: 'https://your-image-host.com/oloolua-1.jpg', caption: 'Oloolua Forest, 2025' },
        ];

        let memoriesIndex = 0;
        let memoriesInterval = null;

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
            track.innerHTML = GROUP_MEMORY_PHOTOS.map(p =>
                `<img src="${p.url}" alt="${escapeHtml(p.caption || 'Group memory')}" loading="lazy">`
            ).join('');
            dotsWrap.innerHTML = GROUP_MEMORY_PHOTOS.map((_, i) =>
                `<span class="memories-dot${i === 0 ? ' active' : ''}"></span>`
            ).join('');

            memoriesIndex = 0;
            updateMemoriesPosition();

            if (memoriesInterval) clearInterval(memoriesInterval);
            if (GROUP_MEMORY_PHOTOS.length > 1 &&
                !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
                memoriesInterval = setInterval(() => {
                    memoriesIndex = (memoriesIndex + 1) % GROUP_MEMORY_PHOTOS.length;
                    updateMemoriesPosition();
                }, 4000);
            }
        }

        function updateMemoriesPosition() {
            const track = document.getElementById('memoriesCarousel');
            if (track) track.style.transform = `translateX(-${memoriesIndex * 100}%)`;
            document.querySelectorAll('.memories-dot').forEach((dot, i) => {
                dot.classList.toggle('active', i === memoriesIndex);
            });
        }

        function applyFilters() {
            const search = document.getElementById('searchInput')?.value.toLowerCase() || '';
            const filterMember = document.getElementById('filterMember')?.value || '';
            const filterType = document.getElementById('filterType')?.value || '';
            let filtered = [...allRecords];
            if (filterMember) filtered = filtered.filter(r => r.member === filterMember);
            if (filterType) filtered = filtered.filter(r => r.type === filterType);
            if (search) filtered = filtered.filter(r => r.member.toLowerCase().includes(search) || (r.message || '')
                .toLowerCase().includes(search));
            if (document.querySelector('.history-modal')) filterHistory();
        }

        // ============================================================
        // EXPORT PDF
        // ============================================================
        function exportToPDF() {
            if (!allRecords.length) {
                showToast('No data to export', 'error');
                return;
            }

            const exportBtn = document.getElementById('exportPdfBtn');
            const exportBtnOrig = exportBtn.innerHTML;
            showButtonLoading(exportBtn, 'Preparing PDF...');

            let savings = 0,
                loansTaken = 0,
                repaid = 0;
            allRecords.forEach(r => {
                if (r.type === 'Savings') savings += r.amount;
                else if (r.type === 'Loan Taken') loansTaken += r.amount;
                else if (r.type === 'Loan Repayment') repaid += r.amount;
            });
            const outstanding = Math.max(0, loansTaken - repaid);
            const net = savings - outstanding;

            const generator = document.getElementById('pdfGenerator');
            const preview = document.getElementById('pdfPreview');
            
            preview.innerHTML = `
                    <div style="text-align: center; padding: 30px;">
                        <div style="width: 40px; height: 40px; border: 3px solid #E7EBF5; border-top-color: #3B6FF2; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 16px;"></div>
                        <p style="color: #7C8AA5; font-size: 14px; font-weight: 500;">Generating PDF...</p>
                        <div style="max-width: 300px; margin: 12px auto; background: #E7EBF5; border-radius: 10px; height: 6px; overflow: hidden;">
                            <div id="pdfProgressBar" style="width: 0%; height: 100%; background: linear-gradient(90deg, #3B6FF2, #14213D); border-radius: 10px; transition: width 0.3s ease;"></div>
                        </div>
                        <p id="pdfProgressText" style="color: #7C8AA5; font-size: 11px; margin-top: 4px;">Initializing...</p>
                    </div>
                `;
            generator.classList.add('active');

            function updateProgress(percent, text) {
                const bar = document.getElementById('pdfProgressBar');
                const textEl = document.getElementById('pdfProgressText');
                if (bar) bar.style.width = Math.min(percent, 100) + '%';
                if (textEl) textEl.textContent = text;
            }

            setTimeout(() => {
                updateProgress(10, 'Building report...');
                const recentRecords = allRecords.slice(-10).reverse();
                updateProgress(30, 'Formatting data...');

                // FIX: capture the real on-screen Chart.js chart as an image so
                // the PDF shows the actual financial donut chart, instead of
                // only the hand-built summary bars below.
                const financialChartImg = chartInstance ? chartInstance.toBase64Image('image/png', 1) : null;

                const contentHtml = `
                        <div id="pdfReportContent" style="max-width: 800px; margin: 0 auto; font-family: Arial, sans-serif; color: #14213D; font-size: 12px; padding: 10px;">
                            <h1 style="color: #14213D; text-align: center; border-bottom: 2px solid #3B6FF2; padding-bottom: 8px; font-size: 20px; margin: 0 0 6px 0;">
                                🏛️ Legacy Builders Group
                            </h1>
                            <h2 style="color: #14213D; text-align: center; font-weight: 400; margin-top: 0; font-size: 15px;">
                                Financial Report
                            </h2>
                            <p style="text-align: center; color: #7C8AA5; font-size: 10px; margin-bottom: 10px;">
                                ${new Date().toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' })}
                            </p>
                            
                            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 6px; margin: 10px 0; background: #F4F6FB; padding: 10px; border-radius: 8px;">
                                <div style="text-align: center;">
                                    <div style="font-size: 8px; color: #7C8AA5; text-transform: uppercase; letter-spacing: 0.5px;">Savings</div>
                                    <div style="font-size: 13px; font-weight: 700; color: #14213D;">KES ${savings.toLocaleString()}</div>
                                </div>
                                <div style="text-align: center;">
                                    <div style="font-size: 8px; color: #7C8AA5; text-transform: uppercase; letter-spacing: 0.5px;">Loans</div>
                                    <div style="font-size: 13px; font-weight: 700; color: #1E3FC4;">KES ${loansTaken.toLocaleString()}</div>
                                </div>
                                <div style="text-align: center;">
                                    <div style="font-size: 8px; color: #7C8AA5; text-transform: uppercase; letter-spacing: 0.5px;">Repaid</div>
                                    <div style="font-size: 13px; font-weight: 700; color: #1E3FC4;">KES ${repaid.toLocaleString()}</div>
                                </div>
                                <div style="text-align: center;">
                                    <div style="font-size: 8px; color: #7C8AA5; text-transform: uppercase; letter-spacing: 0.5px;">Net</div>
                                    <div style="font-size: 13px; font-weight: 700; color: #14213D;">KES ${net.toLocaleString()}</div>
                                </div>
                            </div>

                            ${financialChartImg ? `
                            <div style="margin: 10px 0; background: white; padding: 10px; border-radius: 8px; border: 1px solid #E7EBF5; text-align: center;">
                                <h3 style="color: #14213D; margin: 0 0 8px 0; font-size: 12px;">📊 Financial Overview</h3>
                                <img src="${financialChartImg}" style="max-width: 100%; height: auto;" />
                            </div>` : ''}
                            
                            <h3 style="color: #14213D; margin: 10px 0 4px 0; font-size: 12px;">📜 Recent Transactions (Last ${recentRecords.length})</h3>
                            <table style="width: 100%; border-collapse: collapse; font-size: 9px; margin-top: 4px;">
                                <thead>
                                    <tr style="background: #3B6FF2; color: white;">
                                        <th style="padding: 3px 5px; text-align: left;">Date</th>
                                        <th style="padding: 3px 5px; text-align: left;">Member</th>
                                        <th style="padding: 3px 5px; text-align: left;">Type</th>
                                        <th style="padding: 3px 5px; text-align: right;">Amount</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    ${recentRecords.map(r => `
                                        <tr style="border-bottom: 1px solid #E7EBF5;">
                                            <td style="padding: 3px 5px;">${new Date(r.date).toLocaleDateString('en-KE')}</td>
                                            <td style="padding: 3px 5px; font-weight: 500;">${escapeHtml(r.member)}</td>
                                            <td style="padding: 3px 5px;">${r.type}</td>
                                            <td style="padding: 3px 5px; text-align: right;">${r.type === 'Loan Repayment' ? '+' : (r.type === 'Savings' ? '+' : '-')} KES ${(r.amount || 0).toLocaleString('en-KE')}</td>
                                        </tr>
                                    `).join('')}
                                </tbody>
                            </table>
                            
                            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 8px; background: #F4F6FB; border-radius: 8px;">
                                <div style="text-align: center;">
                                    <div style="font-size: 8px; color: #7C8AA5;">Total Members</div>
                                    <div style="font-size: 13px; font-weight: 700; color: #14213D;">${allMembers.length}</div>
                                </div>
                                <div style="text-align: center;">
                                    <div style="font-size: 8px; color: #7C8AA5;">Total Transactions</div>
                                    <div style="font-size: 13px; font-weight: 700; color: #14213D;">${allRecords.length}</div>
                                </div>
                            </div>
                            
                            <p style="text-align: center; color: #7C8AA5; font-size: 9px; margin-top: 12px; border-top: 1px solid #E7EBF5; padding-top: 10px;">
                                Legacy Builders Group — Building Wealth Together
                            </p>
                            
                            <button class="pdf-generate-btn" id="pdfGenerateBtn" style="background: #3B6FF2; color: #14213D; border: none; padding: 10px 20px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; width: 100%; margin-top: 12px;">
                                📥 Download PDF
                            </button>
                            <button class="pdf-close-btn" onclick="document.getElementById('pdfGenerator').classList.remove('active')" style="position: absolute; top: 8px; right: 16px; background: none; border: none; font-size: 20px; cursor: pointer; color: #7C8AA5; width: auto;">
                                ✕
                            </button>
                        </div>
                    `;

                updateProgress(60, 'Generating preview...');
                preview.innerHTML = contentHtml;
                updateProgress(80, 'Ready to download');

                document.getElementById('pdfGenerateBtn').addEventListener('click', function() {
                    const btn = this;
                    btn.disabled = true;
                    btn.innerHTML = '⏳ Generating...';
                    updateProgress(90, 'Creating PDF file...');

                    // FIX (scrambled PDF, take 3): the report content lives
                    // inside a centered flex overlay (#pdfGenerator, fixed
                    // position + flex centering) nested inside a scrolling
                    // box (#pdfPreview). html2canvas has well-documented
                    // problems correctly measuring elements inside
                    // fixed-position / flex-centered / overflow:auto
                    // ancestor chains — at scale:2-3 this is a common cause
                    // of garbled, duplicated, or misaligned page renders,
                    // independent of any html2canvas option tuning.
                    // The robust fix: clone the report content into a
                    // plain, normally-flowing element appended directly to
                    // <body>, positioned off-screen (not display:none —
                    // html2canvas needs it actually rendered/laid out), so
                    // html2canvas sees a simple element with no weird
                    // ancestor context at all. Remove the clone afterward.
                    const reportSource = document.getElementById('pdfReportContent') || preview;
                    const reportClone = reportSource.cloneNode(true);

                    // Strip the action buttons from the CLONE (the originals
                    // in the live modal are untouched, so the modal still
                    // works normally for the user if generation fails).
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
                        html2canvas: {
                            scale: 2,
                            useCORS: true,
                            logging: false,
                            letterRendering: true,
                            backgroundColor: '#ffffff'
                        },
                        jsPDF: {
                            unit: 'mm',
                            format: 'a4',
                            orientation: 'portrait'
                        },
                        pagebreak: { mode: ['css', 'legacy'] }
                    };

                    html2pdf().set(opt).from(reportClone).save().then(() => {
                        captureHost.remove();
                        btn.disabled = false;
                        btn.innerHTML = '📥 Download PDF';
                        document.getElementById('pdfGenerator').classList.remove('active');
                        updateProgress(100, '✅ Done!');
                        showToast('PDF downloaded successfully!', 'success');
                    }).catch((err) => {
                        captureHost.remove();
                        btn.disabled = false;
                        btn.innerHTML = '📥 Download PDF';
                        showToast('Error generating PDF: ' + err.message, 'error');
                        console.error('PDF Error:', err);
                    });
                });

                updateProgress(100, '✅ Ready');
                hideButtonLoading(exportBtn, exportBtnOrig);
            }, 300);
        }

        // ============================================================
        // ============ PUSH NOTIFICATIONS ============
        // ============================================================

        // Check if browser supports notifications
        function isNotificationSupported() {
            return 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window;
        }

        // Get notification permission status
        function getNotificationPermission() {
            if (!isNotificationSupported()) return 'unsupported';
            return Notification.permission;
        }

        // Show notification prompt if not granted
        function checkAndShowNotificationPrompt() {
            if (!isNotificationSupported()) return;
            
            const permission = getNotificationPermission();
            if (permission === 'default') {
                const prompt = document.getElementById('notificationPrompt');
                if (prompt) {
                    prompt.classList.add('active');
                    setTimeout(() => {
                        prompt.classList.remove('active');
                    }, 10000);
                }
            } else if (permission === 'granted') {
                registerServiceWorker();
            }
        }

        function dismissNotificationPrompt() {
            document.getElementById('notificationPrompt').classList.remove('active');
        }

        // Request notification permission
        async function requestNotificationPermission() {
            if (!isNotificationSupported()) {
                showToast('Notifications are not supported on this browser', 'error');
                return;
            }

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
            } catch (e) {
                console.error('Error requesting notification permission:', e);
                showToast('Error enabling notifications', 'error');
            }
        }

        // Register Service Worker
        async function registerServiceWorker() {
            try {
                if ('serviceWorker' in navigator) {
                    const registration = await navigator.serviceWorker.register('/service-worker.js');
                    console.log('Service Worker registered successfully');
                    serviceWorkerRegistered = true;
                    return registration;
                }
            } catch (e) {
                console.error('Service Worker registration failed:', e);
            }
            return null;
        }

        // Subscribe to push notifications
        // Helper: VAPID keys are base64url — must convert to Uint8Array for the browser API
        function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
                outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
        }

        // Subscribe to push notifications
        async function subscribeToPush() {
            try {
                if (!serviceWorkerRegistered) {
                    await registerServiceWorker();
                }

                const registration = await navigator.serviceWorker.ready;

                // Reuse existing subscription if present, otherwise create one
                let subscription = await registration.pushManager.getSubscription();
                if (!subscription) {
                    subscription = await registration.pushManager.subscribe({
                        userVisibleOnly: true,
                        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
                    });
                }

                // FIX: now that this goes to our own /api/sheets-proxy (same-origin),
                // we don't need the text/plain trick that was used to dodge Apps
                // Script's CORS preflight. Sending proper application/json ensures
                // Vercel parses req.body correctly on the proxy side.
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        action: 'savePushSubscription',
                        email: currentUserEmail,
                        subscription: subscription.toJSON()
                    })
                });

                const res = await response.json();

                if (res.success) {
                    pushSubscription = subscription;
                    console.log('Push subscription saved');
                    showToast('🔔 Push notifications enabled!', 'success');
                } else {
                    console.error('Failed to save subscription:', res.error);
                    showToast('Failed to save subscription: ' + (res.error || 'Unknown error'), 'error');
                }

                return subscription;
            } catch (e) {
                console.error('Push subscription failed:', e);
                showToast('Push subscription failed: ' + e.message, 'error');
                return null;
            }
        }

        // Show browser notification
        function showBrowserNotification(title, body, icon = '🏛️') {
            if (getNotificationPermission() === 'granted') {
                const options = {
                    body: body,
                    icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E🏛️%3C/text%3E%3C/svg%3E',
                    badge: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E🏛️%3C/text%3E%3C/svg%3E',
                    vibrate: [200, 100, 200],
                    requireInteraction: true
                };
                const notification = new Notification(title, options);
                notification.onclick = function() {
                    window.focus();
                    this.close();
                };
                return notification;
            }
            return null;
        }

        // ============================================================
        // TAB ACTIVATION
        // ============================================================
        // Human-readable titles for each full-screen panel's header bar.
        const PANEL_TITLES = {
            summary: '📊 Summary',
            loans: '💰 Loans',
            meetings: '📝 Meetings',
            pending: '⏳ Pending Approvals',
            about: '👥 About Us'
        };

        function ensureFullscreenBar(panel, tabId) {
            if (!panel.classList.contains('fullscreen-panel')) return;
            if (panel.querySelector('.fullscreen-panel-bar')) return; // already injected
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
                // Force a reflow before re-adding the animated class so the
                // entrance animation replays every time a tab is selected,
                // not just the first time this panel becomes active.
                panel.classList.remove('panel-enter');
                void panel.offsetWidth;
                panel.classList.add('active-panel', 'panel-enter');
            }
            // Drives the desktop two-column dashboard grid (see style.css
            // ".app-container.dashboard-active" rule) — only the Home tab
            // uses the side-by-side layout; every other tab is a
            // full-width single view, so this class is removed otherwise.
            // A JS toggle is used instead of relying solely on the CSS
            // :has() selector for broader browser compatibility.
            const appContainer = document.getElementById('appContainer');
            if (appContainer) appContainer.classList.toggle('dashboard-active', tabId === 'transactions');
            localStorage.setItem('legacy_active_tab', tabId);
            currentTab = tabId;
            // FIX (never want to see the balance "load" from my own
            // taps): tapping Home itself never refetches — its data
            // stays whatever it currently is, only ever updated by the
            // silent 30-second background timer or by an action that
            // directly changes the balance (deposit/loan/repayment).
            // Tapping any OTHER tab still refetches so that tab's own
            // data (loans, meetings, summary, etc.) is current — but
            // skipBalanceUI=true means that fetch updates everything
            // EXCEPT the visible Home balance card, so switching tabs
            // never shows the shimmer/count-up animation either.
            if (tabId !== 'transactions') {
                loadAllData(false, true);
            }
        }

        // ============================================================
        // LOGOUT
        // ============================================================
        function logout(event) {
            if (event) { event.stopPropagation();
                event.preventDefault(); }
            if (countdownInterval) clearInterval(countdownInterval);
            localStorage.removeItem('legacy_current_user');
            localStorage.removeItem('legacy_current_email');
            localStorage.removeItem('legacy_active_tab');
            if (refreshInterval) clearInterval(refreshInterval);
            currentUser = null;
            currentUserEmail = null;
            allRecords = [];
            allMembers = [];
            pendingLoans = [];
            completedLoans = [];
            pendingTransactions = [];
            isLoading = false;
            pushSubscription = null;
            serviceWorkerRegistered = false;
            document.getElementById('appContainer').classList.remove('active');
            document.getElementById('tabBar').style.display = 'none';
            document.getElementById('sidebarNav')?.classList.remove('active');
            document.getElementById('loginOverlay').classList.add('active');
            document.getElementById('loginPassword').value = '';
            document.getElementById('loginError').style.display = 'none';
            showToast('Logged out successfully', 'success');
            document.getElementById('splashScreen').style.display = 'flex';
            document.getElementById('splashScreen').classList.remove('hidden');
            setTimeout(hideSplashScreen, 800);
        }

        // ============================================================
        // DOM READY
        // ============================================================
        document.addEventListener('DOMContentLoaded', async () => {
            const splash = document.getElementById('splashScreen');

            // FIX: splash was shown unconditionally on every page load,
            // including refreshes while already logged in — meaning every
            // refresh sat on the splash screen for the full duration of
            // the profile-image fetch + all dashboard data loading before
            // disappearing.
            //
            // FIX (blank white gap): the previous version hid the splash
            // IMMEDIATELY for persistent sessions (before the profile-image
            // fetch even started), but the app container only becomes
            // visible much later, after that fetch resolves — leaving a
            // blank gap of the plain page background in between, visible
            // as a "white flash" especially on slower connections. Now the
            // splash stays visible (briefly, just a spinner — not the
            // full multi-second experience) until the app container is
            // actually ready to be shown, then they swap in the same tick.
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

                const pendingTab = document.getElementById('pendingTab');
                if (pendingTab) pendingTab.style.display = isTreasurer() ? 'flex' : 'none';
                const pendingSidebarLink = document.getElementById('pendingSidebarLink');
                if (pendingSidebarLink) pendingSidebarLink.style.display = isTreasurer() ? 'flex' : 'none';

                showBalanceLoading(true);
                updateDashboardGreeting();
                initMemoriesCarousel();
                // FIX (502s on login — same fix as the fresh-login path):
                // firing all 4 fetches via Promise.all landed them in the
                // same instant, which is exactly the burst pattern
                // confirmed (via Vercel logs) to overwhelm Apps Script and
                // produce intermittent 502s. loadAllData() runs alone
                // first since it's the heaviest call, then the lighter
                // three are staggered 150ms apart.
                await loadAllData();
                await delay(150);
                await Promise.all([
                    loadMeetingMinutes(),
                    delay(150).then(() => loadScheduledMeeting()),
                    delay(300).then(() => loadMembersList())
                ]);
                // FIX: same redundant-fetch issue as the fresh-login path —
                // activateTab() also calls loadAllData() internally, which
                // would re-fetch data that was JUST loaded by Promise.all
                // above. Set panel/nav state directly instead.
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

                setTimeout(() => {
                    checkAndShowNotificationPrompt();
                }, 3000);

                if (refreshInterval) clearInterval(refreshInterval);
                refreshInterval = setInterval(() => {
                    if (currentUser) {
                        loadAllData(true); // silent: background refresh shouldn't blank the balance
                        loadScheduledMeeting();
                        loadMembersList();
                    }
                }, 30000);
            } else {
                hideSplashScreen();
                document.getElementById('loginOverlay').classList.add('active');
            }

            // Event listeners
            document.getElementById('addBtn').onclick = addRecord;
            document.getElementById('exportPdfBtn').onclick = exportToPDF;
            document.getElementById('loginPassword')?.addEventListener('keypress', (e) => { if (e.key === 'Enter')
                    loginWithPassword(); });
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