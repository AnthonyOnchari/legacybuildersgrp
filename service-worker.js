// service-worker.js
// This must be in the root directory of your website

self.addEventListener('install', function(event) {
    console.log('Service Worker installed');
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function(event) {
    console.log('Service Worker activated');
    event.waitUntil(self.clients.claim());
});

// Handle push notifications
self.addEventListener('push', function(event) {
    console.log('Push notification received:', event);
    
    let data = {
        title: '🏛️ Legacy Builders Group',
        body: 'You have a new notification',
        icon: '🏛️',
        data: {}
    };
    
    try {
        if (event.data) {
            const parsed = event.data.json();
            data = {
                title: parsed.title || data.title,
                body: parsed.body || data.body,
                icon: '🏛️',
                data: parsed.data || {},
                timestamp: parsed.timestamp || new Date().toISOString()
            };
        }
    } catch (e) {
        console.error('Error parsing push data:', e);
    }
    
    const options = {
        body: data.body,
        icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E🏛️%3C/text%3E%3C/svg%3E',
        badge: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ctext y=".9em" font-size="90"%3E🏛️%3C/text%3E%3C/svg%3E',
        vibrate: [200, 100, 200],
        data: data.data || {},
        requireInteraction: true,
        actions: [
            {
                action: 'open',
                title: '📱 Open App'
            },
            {
                action: 'close',
                title: '❌ Dismiss'
            }
        ]
    };
    
    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Handle notification clicks
self.addEventListener('notificationclick', function(event) {
    console.log('Notification clicked:', event);
    event.notification.close();
    
    if (event.action === 'close') {
        return;
    }
    
    if (event.action === 'open') {
        event.waitUntil(
            clients.openWindow('/')
        );
        return;
    }
    
    // Default: open the app
    event.waitUntil(
        clients.matchAll({ 
            type: 'window', 
            includeUncontrolled: true 
        })
        .then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
                const client = clientList[i];
                if (client.url.includes('/') && 'focus' in client) {
                    return client.focus();
                }
            }
            return clients.openWindow('/');
        })
    );
});