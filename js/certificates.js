// Think and Crack SQL — Certificate & Achievement Engine
// Data2Dashboard (D2D) • Crack SQL Learning Platform

import { escapeHtml } from './util.js';

const CERT_STORAGE_KEY = 'cracksql_user_certificates_v1';

/**
 * Reads locally cached certificates (for guest or offline resilience)
 */
export function getLocalCertificates(userId = 'guest') {
  try {
    const raw = localStorage.getItem(`${CERT_STORAGE_KEY}_${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch (_) {
    return [];
  }
}

/**
 * Saves a certificate to local storage cache
 */
export function saveLocalCertificate(cert, userId = 'guest') {
  try {
    const list = getLocalCertificates(userId);
    const existingIdx = list.findIndex(c => c.domain === cert.domain && c.level === cert.level);
    if (existingIdx >= 0) {
      list[existingIdx] = cert;
    } else {
      list.push(cert);
    }
    localStorage.setItem(`${CERT_STORAGE_KEY}_${userId}`, JSON.stringify(list));
  } catch (_) {}
}

/**
 * Returns formatted course title from level
 */
export function getCourseTitle(level) {
  const norm = String(level || '').toLowerCase();
  if (norm.includes('beg')) return 'Crack SQL: Beginner SQL Practitioner';
  if (norm.includes('int')) return 'Crack SQL: Intermediate SQL Practitioner';
  if (norm.includes('exp')) return 'Crack SQL: Expert SQL Practitioner';
  return `Crack SQL: ${level} SQL Practitioner`;
}

/**
 * Formats a date into "07 October 2026" format
 */
export function formatCertificateDate(dateStr) {
  try {
    const d = dateStr ? new Date(dateStr) : new Date();
    if (isNaN(d.getTime())) return new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  } catch (_) {
    return '07 October 2026';
  }
}

/**
 * Generates the public verification URL
 */
export function getVerificationUrl(credentialId) {
  const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
    ? window.location.origin
    : 'https://crack-sql-d2d.netlify.app';
  return `${origin}/index.html?verify=${encodeURIComponent(credentialId)}`;
}

/**
 * Generates LinkedIn "Add to Profile" certification URL
 */
export function getLinkedInCertUrl(cert) {
  const d = cert.completed_at ? new Date(cert.completed_at) : new Date();
  const year = isNaN(d.getFullYear()) ? new Date().getFullYear() : d.getFullYear();
  const month = isNaN(d.getMonth()) ? (new Date().getMonth() + 1) : (d.getMonth() + 1);
  const verifyUrl = getVerificationUrl(cert.credential_id);

  const params = new URLSearchParams({
    startTask: 'CERTIFICATION_NAME',
    name: cert.course_title || getCourseTitle(cert.level),
    organizationName: 'Data2Dashboard (D2D)',
    issueYear: String(year),
    issueMonth: String(month),
    certId: cert.credential_id || '',
    certUrl: verifyUrl
  });

  return `https://www.linkedin.com/profile/add?${params.toString()}`;
}

/**
 * Renders the certificate onto an HTML5 Canvas at 2x resolution (2400 x 1600)
 * Matching the exact visual design of the original reference certificate.
 */
export function renderCertificateToCanvas(cert, canvas) {
  const width = 2400;
  const height = 1600;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // 1. Crisp White Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // 2. Borders
  // Outer Dark Border
  ctx.strokeStyle = '#0f172a';
  ctx.lineWidth = 14;
  ctx.strokeRect(60, 60, width - 120, height - 120);

  // Inner Gold Border
  ctx.strokeStyle = '#d97706';
  ctx.lineWidth = 4;
  ctx.strokeRect(84, 84, width - 168, height - 168);

  // 3. Top Header Row
  ctx.fillStyle = '#64748b';
  ctx.font = 'bold 24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('D2D  •  DATA2DASHBOARD', 130, 150);

  ctx.textAlign = 'right';
  ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
  ctx.fillStyle = '#475569';
  const credId = cert.credential_id || 'D2D-CSQL-SAMPLE';
  ctx.fillText(`CREDENTIAL ID: ${credId}`, width - 130, 150);

  // 4. Certificate Heading
  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 76px "Playfair Display", Georgia, "Times New Roman", serif';
  ctx.fillText('CERTIFICATE OF ACHIEVEMENT', width / 2, 330);

  // 5. Salutation
  ctx.fillStyle = '#64748b';
  ctx.font = '32px "Playfair Display", Georgia, serif';
  ctx.fillText('This is proudly presented to', width / 2, 440);

  // 6. Recipient Name (Elegant Gold)
  const recipientName = (cert.recipient_name || 'Learner').trim();
  ctx.fillStyle = '#b45309';
  let nameFontSize = 96;
  ctx.font = `bold ${nameFontSize}px "Playfair Display", Georgia, serif`;
  while (ctx.measureText(recipientName).width > width - 400 && nameFontSize > 48) {
    nameFontSize -= 4;
    ctx.font = `bold ${nameFontSize}px "Playfair Display", Georgia, serif`;
  }
  ctx.fillText(recipientName, width / 2, 570);

  // 7. Subheading
  ctx.fillStyle = '#64748b';
  ctx.font = '30px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('for successfully completing the scenario-based learning track', width / 2, 690);

  // 8. Course Title
  const courseTitle = cert.course_title || getCourseTitle(cert.level);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 54px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(courseTitle, width / 2, 790);

  // 9. Description Text
  const description = cert.description || `Successfully completed 20 scenario-based SQL challenges in ${cert.domain || 'SQL'}.`;
  ctx.fillStyle = '#334155';
  ctx.font = '34px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(description, width / 2, 880);

  // 10. Footer Section
  const footerY = 1320;

  // Left Block: Issuer
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(180, footerY - 50);
  ctx.lineTo(540, footerY - 50);
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 32px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Data2Dashboard (D2D)', 360, footerY - 5);
  ctx.fillStyle = '#64748b';
  ctx.font = '24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Crack SQL Learning Platform', 360, footerY + 36);

  // Center Block: Circular Gold Seal Badge
  const sealX = width / 2;
  const sealY = footerY - 40;
  const sealRadius = 110;

  // Outer Gold Circle
  const sealGrad = ctx.createRadialGradient(sealX - 20, sealY - 20, 10, sealX, sealY, sealRadius);
  sealGrad.addColorStop(0, '#f59e0b');
  sealGrad.addColorStop(0.7, '#d97706');
  sealGrad.addColorStop(1, '#b45309');

  ctx.fillStyle = sealGrad;
  ctx.beginPath();
  ctx.arc(sealX, sealY, sealRadius, 0, Math.PI * 2);
  ctx.fill();

  // Seal Borders
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(sealX, sealY, sealRadius - 10, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = '#fef3c7';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(sealX, sealY, sealRadius - 18, 0, Math.PI * 2);
  ctx.stroke();

  // Text inside Seal
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.font = 'bold 26px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('D2D', sealX, sealY - 32);
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('CRACK SQL', sealX, sealY + 2);
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
  const levelUpper = String(cert.level || 'BEGINNER').toUpperCase();
  ctx.fillText(levelUpper, sealX, sealY + 34);

  // Right Block: Date Awarded
  ctx.beginPath();
  ctx.moveTo(width - 540, footerY - 50);
  ctx.lineTo(width - 180, footerY - 50);
  ctx.stroke();

  ctx.fillStyle = '#64748b';
  ctx.font = '24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Date Awarded', width - 360, footerY - 15);
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 30px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const dateFormatted = formatCertificateDate(cert.completed_at);
  ctx.fillText(dateFormatted, width - 360, footerY + 26);

  // Bottom Kicker Caption
  ctx.fillStyle = '#94a3b8';
  ctx.font = '600 18px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
  ctx.fillText('VERIFIED CREDENTIAL  •  DATA2DASHBOARD (D2D)', width / 2, height - 95);
}

/**
 * Downloads Certificate as a high-resolution PNG image
 */
export async function downloadCertificateImage(cert) {
  const canvas = document.createElement('canvas');
  renderCertificateToCanvas(cert, canvas);
  const dataUrl = canvas.toDataURL('image/png');
  const filename = `Certificate_${(cert.domain || 'Domain').replace(/\s+/g, '_')}_${cert.level || 'Level'}_${(cert.recipient_name || 'Learner').replace(/\s+/g, '_')}.png`;

  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Downloads Certificate as an A4 Landscape PDF
 */
export async function downloadCertificatePdf(cert) {
  const canvas = document.createElement('canvas');
  renderCertificateToCanvas(cert, canvas);
  const dataUrl = canvas.toDataURL('image/png');
  const filename = `Certificate_${(cert.domain || 'Domain').replace(/\s+/g, '_')}_${cert.level || 'Level'}.pdf`;

  // Create clean printable iframe for instant A4 landscape print/PDF
  const printFrame = document.createElement('iframe');
  printFrame.style.position = 'fixed';
  printFrame.style.right = '0';
  printFrame.style.bottom = '0';
  printFrame.style.width = '0';
  printFrame.style.height = '0';
  printFrame.style.border = '0';
  document.body.appendChild(printFrame);

  const frameDoc = printFrame.contentWindow?.document || printFrame.contentDocument;
  if (!frameDoc) return downloadCertificateImage(cert);

  frameDoc.write(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>${escapeHtml(cert.course_title || 'Certificate of Achievement')}</title>
        <style>
          @page {
            size: A4 landscape;
            margin: 0;
          }
          html, body {
            margin: 0;
            padding: 0;
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #ffffff;
          }
          img {
            width: 100vw;
            height: 100vh;
            object-fit: contain;
          }
        </style>
      </head>
      <body>
        <img src="${dataUrl}" alt="Certificate" />
      </body>
    </html>
  `);
  frameDoc.close();

  setTimeout(() => {
    try {
      printFrame.contentWindow?.focus();
      printFrame.contentWindow?.print();
    } catch (_) {
      // Fallback: download image if print fails
      downloadCertificateImage(cert);
    }
    setTimeout(() => document.body.removeChild(printFrame), 2000);
  }, 500);
}

/**
 * Native or Web Share helper for Certificate
 */
export async function shareCertificate(cert) {
  const verifyUrl = getVerificationUrl(cert.credential_id);
  const shareTitle = `${cert.recipient_name} earned ${cert.course_title}`;
  const shareText = `I have successfully completed all 20 scenario-based SQL challenges in ${cert.domain} on Crack SQL by Data2Dashboard (D2D)! Verify my credential: ${verifyUrl}`;

  if (typeof navigator !== 'undefined' && navigator.share) {
    try {
      const canvas = document.createElement('canvas');
      renderCertificateToCanvas(cert, canvas);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (blob && navigator.canShare && navigator.canShare({ files: [new File([blob], 'certificate.png', { type: 'image/png' })] })) {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          files: [new File([blob], 'certificate.png', { type: 'image/png' })]
        });
        return { shared: true };
      }

      await navigator.share({
        title: shareTitle,
        text: shareText,
        url: verifyUrl
      });
      return { shared: true };
    } catch (err) {
      if (err.name === 'AbortError') return { shared: false, aborted: true };
    }
  }

  // Fallback: copy verification link
  try {
    await navigator.clipboard.writeText(verifyUrl);
    return { shared: false, copied: true, url: verifyUrl };
  } catch (_) {
    return { shared: false, copied: false, url: verifyUrl };
  }
}

/**
 * Renders Scenario Achievement Card to Canvas (1200 x 630 px)
 * For sharing individual scenario completion (Requirement 6)
 */
export function renderScenarioAchievementCanvas(achievement, canvas) {
  const width = 1200;
  const height = 630;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Modern Dark Navy Branded Card
  const grad = ctx.createLinearGradient(0, 0, width, height);
  grad.addColorStop(0, '#0f172a');
  grad.addColorStop(0.5, '#1e293b');
  grad.addColorStop(1, '#0f172a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Outer border
  ctx.strokeStyle = '#334155';
  ctx.lineWidth = 4;
  ctx.strokeRect(20, 20, width - 40, height - 40);

  // Gold Inner Accent Header Line
  const goldGrad = ctx.createLinearGradient(60, 0, width - 60, 0);
  goldGrad.addColorStop(0, '#f59e0b');
  goldGrad.addColorStop(0.5, '#d97706');
  goldGrad.addColorStop(1, '#f59e0b');
  ctx.fillStyle = goldGrad;
  ctx.fillRect(60, 60, width - 120, 6);

  // Brand Kicker
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('CRACK SQL  •  DATA2DASHBOARD (D2D)', 70, 115);

  // Achievement Title
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 50px "Playfair Display", Georgia, serif';
  ctx.fillText('Scenario Challenge Cracked! 🚀', 70, 195);

  // Recipient / Learner Display Name
  ctx.fillStyle = '#fbbf24';
  ctx.font = 'bold 36px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const name = achievement.name || 'Learner';
  ctx.fillText(`@${name}`, 70, 260);

  // Domain & Level
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '500 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  const domainLevel = `${achievement.domain || 'SQL'}  —  ${achievement.level || 'Beginner'} Level`;
  ctx.fillText(domainLevel, 70, 315);

  // Progress Stat
  const progressText = `Scenario ${achievement.questionNo || achievement.completedCount || 1} of 20 Solved`;
  ctx.fillStyle = '#94a3b8';
  ctx.font = '24px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText(progressText, 70, 365);

  // Thinking Score Badge Card
  const badgeX = width - 420;
  const badgeY = 160;
  ctx.fillStyle = 'rgba(30, 41, 59, 0.85)';
  ctx.strokeStyle = '#22c55e';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, 340, 240, 20);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#86efac';
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('VERIFIED THINKING SCORE', badgeX + 170, badgeY + 50);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 80px -apple-system, BlinkMacSystemFont, sans-serif';
  const score = achievement.score || 10;
  ctx.fillText(`${score} / 10`, badgeX + 170, badgeY + 145);

  ctx.fillStyle = '#22c55e';
  ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, sans-serif';
  ctx.fillText('✓ Passed with Distinction', badgeX + 170, badgeY + 195);

  // Footer Tagline
  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.font = '20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('Think like a Data Engineer  •  Plan in English  •  Crack the SQL', 70, height - 70);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#38bdf8';
  ctx.font = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillText('datatodashboard.com', width - 70, height - 70);
}

/**
 * Downloads Scenario Achievement Card as PNG
 */
export async function downloadScenarioAchievementImage(achievement) {
  const canvas = document.createElement('canvas');
  renderScenarioAchievementCanvas(achievement, canvas);
  const dataUrl = canvas.toDataURL('image/png');
  const filename = `CrackSQL_Achievement_${achievement.domain || 'SQL'}_Scenario_${achievement.questionNo || 1}.png`;

  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
