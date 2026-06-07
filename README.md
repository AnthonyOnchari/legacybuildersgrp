# legacybuildersgrp

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <title>Legacy Builders Group — Maintenance</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            background: linear-gradient(135deg, #1e3c32 0%, #0f2a22 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 20px;
        }

        .maintenance-container {
            max-width: 550px;
            width: 100%;
            background: white;
            border-radius: 48px;
            padding: 48px 32px 56px;
            text-align: center;
            box-shadow: 0 30px 60px rgba(0, 0, 0, 0.3);
            animation: fadeInUp 0.5s ease-out;
        }

        @keyframes fadeInUp {
            from {
                opacity: 0;
                transform: translateY(30px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        .icon {
            font-size: 80px;
            margin-bottom: 20px;
            display: inline-block;
            animation: gentlePulse 2s infinite ease;
        }

        @keyframes gentlePulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }

        h1 {
            font-size: 32px;
            font-weight: 700;
            color: #1e3c32;
            margin-bottom: 12px;
        }

        .status-badge {
            display: inline-block;
            background: #fef3c7;
            color: #b45309;
            padding: 6px 18px;
            border-radius: 100px;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 24px;
        }

        .message {
            color: #334155;
            font-size: 16px;
            line-height: 1.5;
            margin-bottom: 28px;
        }

        .progress-section {
            margin: 32px 0;
        }

        .progress-bar-bg {
            background: #e2e8f0;
            border-radius: 30px;
            height: 8px;
            overflow: hidden;
            margin: 16px 0;
        }

        .progress-fill {
            width: 65%;
            height: 100%;
            background: linear-gradient(90deg, #2a5a4a, #3b8b72);
            border-radius: 30px;
            animation: shimmer 1.8s infinite ease;
        }

        @keyframes shimmer {
            0% { opacity: 0.7; width: 55%; }
            50% { opacity: 1; width: 75%; }
            100% { opacity: 0.7; width: 55%; }
        }

        .loading-dots {
            display: flex;
            justify-content: center;
            gap: 8px;
            margin: 20px 0;
        }

        .loading-dots span {
            width: 10px;
            height: 10px;
            background: #2a5a4a;
            border-radius: 50%;
            display: inline-block;
            animation: bounce 1.4s infinite ease-in-out both;
        }

        .loading-dots span:nth-child(1) { animation-delay: -0.32s; }
        .loading-dots span:nth-child(2) { animation-delay: -0.16s; }

        @keyframes bounce {
            0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
            40% { transform: scale(1); opacity: 1; }
        }

        .info-list {
            text-align: left;
            background: #f8fafc;
            border-radius: 28px;
            padding: 20px;
            margin: 24px 0;
        }

        .info-list p {
            display: flex;
            align-items: center;
            gap: 12px;
            font-size: 14px;
            color: #1e293b;
            margin: 12px 0;
        }

        .info-list span.emoji {
            font-size: 20px;
            min-width: 32px;
        }

        .contact {
            font-size: 13px;
            color: #64748b;
            margin-top: 28px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
        }

        .retry-btn {
            background: #2a5a4a;
            color: white;
            border: none;
            padding: 12px 28px;
            border-radius: 40px;
            font-size: 15px;
            font-weight: 600;
            cursor: pointer;
            margin-top: 12px;
            transition: all 0.2s;
        }

        .retry-btn:hover {
            background: #1e3c32;
            transform: scale(1.02);
        }

        .retry-btn:active {
            transform: scale(0.98);
        }

        .timestamp {
            font-family: monospace;
            font-size: 12px;
            color: #94a3b8;
            margin-top: 16px;
        }
    </style>
</head>
<body>
    <div class="maintenance-container">
        <div class="icon">🛠️⚙️</div>
        <h1>Be Back Shortly</h1>
        <div class="status-badge">🔧 System Maintenance</div>
        
        <div class="message">
            Legacy Builders Group is currently being upgraded.<br>
            We're fixing errors and improving performance.
        </div>

        <div class="progress-section">
            <div class="progress-bar-bg">
                <div class="progress-fill"></div>
            </div>
            <div class="loading-dots">
                <span></span>
                <span></span>
                <span></span>
            </div>
        </div>

        <div class="info-list">
            <p><span class="emoji">📋</span> Fixing transaction & loan approval logic</p>
            <p><span class="emoji">🔐</span> Updating PIN change security</p>
            <p><span class="emoji">📊</span> Optimizing summary dashboard</p>
            <p><span class="emoji">🔄</span> Database sync improvements</p>
        </div>

        <button class="retry-btn" onclick="checkSystemStatus()">
            ⟳ Check Again
        </button>

        <div class="contact">
            <p>📧 Contact support: <strong>legacybuilders@group.com</strong></p>
            <p>⏱️ Expected completion: <span id="eta">within 30 minutes</span></p>
        </div>
        <div class="timestamp">
            Last update: <span id="currentTime"></span>
        </div>
    </div>

    <script>
        // Display current time
        function updateTimestamp() {
            const now = new Date();
            const timeStr = now.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
            document.getElementById('currentTime').innerText = timeStr;
        }
        updateTimestamp();
        setInterval(updateTimestamp, 60000);

        // Function to check if system is back (simulated / real redirect)
        function checkSystemStatus() {
            const btn = document.querySelector('.retry-btn');
            const originalText = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '⏳ Checking...';
            
            // Option A: Simulate redirect after 2 seconds (comment out if you want manual redirect)
            // Option B: Try to ping your real app URL
            // Replace 'YOUR_APPS_SCRIPT_URL' with your actual endpoint when ready
            const APP_URL = 'https://script.google.com/macros/s/AKfycbxC9QoA88vJsCIXCU5YHSdLxxnUj5lEIgvR9nEbHJ3VXWu-oWVJJIa3yxFndQL1navrPw/exec';
            
            // Try to fetch a lightweight ping (optional, avoid CORS issues)
            fetch(APP_URL + '?action=getMembers', {
                method: 'GET',
                cache: 'no-cache'
            })
            .then(response => {
                if (response.ok) {
                    return response.json();
                }
                throw new Error('not ready');
            })
            .then(data => {
                // If we get a successful response, redirect to main app
                if (data && data.success !== false) {
                    window.location.href = 'index.html';  // or your main app page
                } else {
                    throw new Error('still in maintenance');
                }
            })
            .catch(() => {
                // Still down: show message and reset button
                btn.disabled = false;
                btn.innerHTML = originalText;
                
                // Visual feedback
                const statusBadge = document.querySelector('.status-badge');
                const originalBadgeText = statusBadge.innerHTML;
                statusBadge.innerHTML = '⏳ Still fixing...';
                statusBadge.style.background = '#fee2e2';
                statusBadge.style.color = '#991b1b';
                setTimeout(() => {
                    statusBadge.innerHTML = originalBadgeText;
                    statusBadge.style.background = '#fef3c7';
                    statusBadge.style.color = '#b45309';
                }, 2000);
            });
        }

        // Auto redirect detection every 45 seconds (optional)
        let checkInterval = setInterval(() => {
            const APP_URL = 'https://script.google.com/macros/s/AKfycbxC9QoA88vJsCIXCU5YHSdLxxnUj5lEIgvR9nEbHJ3VXWu-oWVJJIa3yxFndQL1navrPw/exec';
            fetch(APP_URL + '?action=getMembers', { method: 'GET', cache: 'no-cache' })
                .then(res => res.json())
                .then(data => {
                    if (data && data.success !== false) {
                        clearInterval(checkInterval);
                        window.location.href = 'index.html';
                    }
                })
                .catch(() => {});
        }, 45000);
    </script>
</body>
</html>
