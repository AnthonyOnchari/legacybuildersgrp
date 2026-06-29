// api/sheets-proxy.js
// Place this file at: /api/sheets-proxy.js in your Vercel project root
// Vercel auto-detects anything in /api as a serverless function — no extra config needed.

const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz3GiEJb_AZeu4FPZAKN2XiLiB-FBN58JEIW39MPIuPLeFvZDFv0xsf45jfxEevY1uz/exec";

export default async function handler(req, res) {
  // Allow your front-end origin (or "*" while testing)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    if (req.method === 'GET') {
      // Forward all query params (action, email, etc.) straight to Apps Script
      const params = new URLSearchParams(req.query).toString();
      const targetUrl = `${APPS_SCRIPT_URL}?${params}`;

      const appsScriptRes = await fetch(targetUrl, {
        method: 'GET',
        redirect: 'follow' // server-to-server redirects are fine, no CORS involved
      });

      const text = await appsScriptRes.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Non-JSON response from Apps Script:', text.slice(0, 300));
        return res.status(502).json({
          success: false,
          error: 'Apps Script returned a non-JSON response (check deployment access settings).'
        });
      }

      return res.status(200).json(data);

    } else if (req.method === 'POST') {
      // req.body is already parsed JSON by Vercel for Content-Type: application/json
      const appsScriptRes = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.body),
        redirect: 'follow'
      });

      const text = await appsScriptRes.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        console.error('Non-JSON response from Apps Script:', text.slice(0, 300));
        return res.status(502).json({
          success: false,
          error: 'Apps Script returned a non-JSON response (check deployment access settings).'
        });
      }

      return res.status(200).json(data);

    } else {
      return res.status(405).json({ success: false, error: 'Method not allowed' });
    }
  } catch (e) {
    console.error('Proxy error:', e);
    return res.status(500).json({ success: false, error: e.message });
  }
}