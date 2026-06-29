// api/send-push.js
const webPush = require('web-push');

// FIX: VAPID keys now read from Vercel environment variables instead of being
// hardcoded in source. Your original file had the private key committed in
// plaintext — that's a real leak risk if this repo is ever public or shared.
// Set these in Vercel: Project Settings -> Environment Variables
//   VAPID_PUBLIC_KEY  = BHyIXHgBdbBrRhFP7RRUKhIItMR6z8e_a_5TKmdexZXK12R9ftEGrUCLlTDZXwP-4p8AFNK26D05wZArdn2i9Mw
//   VAPID_PRIVATE_KEY = <your private key>
//   VAPID_EMAIL       = info.onchari@gmail.com
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:info.onchari@gmail.com';

webPush.setVapidDetails(
    VAPID_EMAIL.startsWith('mailto:') ? VAPID_EMAIL : `mailto:${VAPID_EMAIL}`,
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

    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
        console.error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY environment variables');
        return res.status(500).json({
            success: false,
            error: 'Server is missing VAPID configuration. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Vercel.'
        });
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