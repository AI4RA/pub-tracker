#!/usr/bin/env node
// Optional email notice for new papers, over SMTP. Does nothing unless
// SMTP_HOST and NOTIFY_EMAIL are set (as repository secrets), so the GitHub
// issue notice works on its own without any mail setup.

import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const env = k => (process.env[k] || '').trim();

const host = env('SMTP_HOST');
const to = env('NOTIFY_EMAIL');
const file = env('NEW_FILE') || 'data/new-papers.md';
if (!host || !to) {
  console.log('SMTP_HOST or NOTIFY_EMAIL not set; skipping email (the GitHub issue notice still goes out).');
  process.exit(0);
}
if (!fs.existsSync(file)) {
  console.log(`No ${file}; nothing to send.`);
  process.exit(0);
}

const nodemailer = require('nodemailer');
const body = fs.readFileSync(file, 'utf8');
const count = env('NEW_COUNT') || '';
const port = Number(env('SMTP_PORT') || 587);
const transport = nodemailer.createTransport({
  host,
  port,
  secure: port === 465,
  auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASSWORD') } : undefined,
});

// Plain text from the Markdown: links become "title <url>".
const text = body.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>').replace(/\*\*/g, '').replace(/^### /gm, '');
const html = '<div style="font-family:sans-serif;line-height:1.5">' + body
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/^### (.*)$/gm, '<h3>$1</h3>')
  .replace(/^- (.*)$/gm, '<li>$1</li>')
  .replace(/\n{2,}/g, '<br>') + '</div>';

await transport.sendMail({
  from: env('SMTP_FROM') || env('SMTP_USER'),
  to: to.split(/[,;]\s*/),
  subject: `Pub Tracker: ${count ? `${count} ` : ''}new paper${count === '1' ? '' : 's'}`,
  text,
  html,
});
console.log(`Emailed ${to}.`);
