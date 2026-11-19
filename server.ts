/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ProxyError,
  capturePublicSite,
  proxyPublicAsset,
  sanitizeAndRewriteHtml,
} from './server/siteProxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer(): Promise<void> {
  const app = express();
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'pagebreaker',
      step: 3,
      timestamp: Date.now(),
    });
  });

  app.get('/api/capture-site', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!rawUrl) {
      res.status(400).json({ ok: false, error: 'Missing required ?url= query parameter.' });
      return;
    }

    try {
      const result = await capturePublicSite(rawUrl);
      res.setHeader('Cache-Control', 'no-store');
      res.json(result);
    } catch (err) {
      const status = err instanceof ProxyError ? err.statusCode : 502;
      const message = err instanceof Error ? err.message : 'Unable to capture target website.';
      res.status(status).json({ ok: false, error: message });
    }
  });

  app.post('/api/sanitize-html', (req, res) => {
    const body = req.body as { html?: unknown; baseUrl?: unknown };
    const rawHtml = typeof body?.html === 'string' ? body.html : '';
    const baseUrl =
      typeof body?.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl.trim() : 'https://pasted.local/';

    if (!rawHtml.trim()) {
      res.status(400).json({ ok: false, error: 'No HTML content provided.' });
      return;
    }

    const sanitized = sanitizeAndRewriteHtml(rawHtml, baseUrl);
    res.json({
      ok: true,
      finalUrl: baseUrl,
      baseUrl,
      title: sanitized.title,
      html: sanitized.html,
      spaRecovered: false,
      byteLength: Buffer.byteLength(rawHtml, 'utf8'),
    });
  });

  app.get('/api/proxy-asset', async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url : '';
    if (!rawUrl) {
      res.status(400).send('Missing ?url= query parameter.');
      return;
    }

    try {
      const asset = await proxyPublicAsset(rawUrl);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.setHeader('Content-Type', asset.contentType);
      res.send(asset.body);
    } catch (err) {
      const status = err instanceof ProxyError ? err.statusCode : 502;
      const message = err instanceof Error ? err.message : 'Asset proxy failure.';
      res.status(status).send(message);
    }
  });

  if (isProd) {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`PageBreaker server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start PageBreaker server:', error);
  process.exit(1);
});
