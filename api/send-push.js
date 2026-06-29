// api/send-push.js
const webPush = require('web-push');

// Your VAPID keys from Firebase (copy exactly from screenshot)
const VAPID_PUBLIC_KEY = 'BHyIXHgBdbBrRhFP7RRUKHlItMR6z8e_a_5TKmdexZXK12R9ftEGr';
const VAPID_PRIVATE_KEY = 'UCLITDZXwP-4p8AFNK26D05wZArdn2j9Mw';

webPush.setVapidDetails(
    'mailto:info.onchari@gmail.com', // Change this to your email
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { subscription, title, body, data } = req.body;

        if (!subscription) {
            return res.status(400).json({ error: 'Subscription is required' });
        }

        const payload = JSON.stringify({
            title: title || '🏛️ Legacy Builders Group',
            body: body || 'You have a new notification',
            data: data || {},
            timestamp: new Date().toISOString()
        });

        await webPush.sendNotification(subscription, payload);

        res.status(200).json({ success: true });
    } catch (error) {
        console.error('Push error:', error);
        
        if (error.statusCode === 410) {
            return res.status(410).json({ 
                success: false, 
                error: 'Subscription expired',
                expired: true 
            });
        }

        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
    }
}