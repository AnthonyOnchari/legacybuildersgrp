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

self.addEventListener('push', function(event) {
    let data = {
        title: 'NBFA GROUP',
        body: 'You have a new notification',
        data: {}
    };

    try {
        if (event.data) {
            const parsed = event.data.json();
            data = {
                title: parsed.title || data.title,
                body: parsed.body || data.body,
                data: parsed.data || {},
                timestamp: parsed.timestamp || new Date().toISOString()
            };
        }
    } catch (e) {
        console.error('Error parsing push data:', e);
    }

    const parsedTimestamp = Date.parse(data.timestamp);
    const options = {
        body: data.body,
        icon: '/Assets/notification-icon.png',
        badge: '/Assets/notification-icon.png',
        timestamp: Number.isNaN(parsedTimestamp) ? Date.now() : parsedTimestamp,
        dir: 'auto',
        lang: 'en',
        data: data.data || {},
        requireInteraction: false
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();

    event.waitUntil(
        clients.matchAll({ 
            type: 'window', 
            includeUncontrolled: true 
        })
        .then(function(clientList) {
            const appClient = clientList.find(function(client) {
                return new URL(client.url).origin === self.location.origin;
            });
            if (appClient && 'focus' in appClient) return appClient.focus();
            return clients.openWindow('/');
        })
    );
});
