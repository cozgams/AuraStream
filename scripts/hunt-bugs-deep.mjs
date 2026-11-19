import fs from 'fs';
import path from 'path';

console.log("=== STARTING DEEP CODEBASE & RUNTIME BUG HUNT ===");

const SRC_DIR = '/data/home/Project/A/HGhubX/src';
const issues = [];

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(fullPath);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      inspectFile(fullPath);
    }
  }
}

function inspectFile(file) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative('/data/home/Project/A/HGhubX', file);

  // 1. Check for uncleaned addEventListener in useEffect
  const listenerMatches = content.match(/window\.addEventListener\([^)]+\)/g);
  if (listenerMatches) {
    for (const match of listenerMatches) {
      const eventNameMatch = match.match(/window\.addEventListener\(["']([^"']+)["']/);
      if (eventNameMatch) {
        const ev = eventNameMatch[1];
        if (!content.includes(`removeEventListener("${ev}"`) && !content.includes(`removeEventListener('${ev}'`)) {
          issues.push({
            file: rel,
            severity: 'HIGH',
            type: 'MEMORY_LEAK',
            message: `Event listener for "${ev}" is added with window.addEventListener but not properly removed with removeEventListener!`,
          });
        }
      }
    }
  }

  // 2. Check for setInterval without clearInterval
  if (content.includes('setInterval(') && !content.includes('clearInterval(')) {
    issues.push({
      file: rel,
      severity: 'HIGH',
      type: 'TIMER_LEAK',
      message: `File uses setInterval but has no clearInterval! Potential background timer leak.`,
    });
  }

  // 3. Check for setTimeout in useEffect without cleanup
  const effectTimeoutMatches = content.match(/useEffect\(\(\)\s*=>\s*\{[^}]*setTimeout\([^}]*\},?\s*\[/g);
  if (effectTimeoutMatches) {
    for (const m of effectTimeoutMatches) {
      if (!m.includes('clearTimeout') && !m.includes('return () =>')) {
        issues.push({
          file: rel,
          severity: 'MEDIUM',
          type: 'TIMER_LEAK',
          message: `useEffect sets timeout without returning a cleanup function with clearTimeout.`,
        });
      }
    }
  }

  // 4. Check for unhandled JSON.parse that could crash app on corrupted localStorage
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (line.includes('JSON.parse(localStorage.getItem(') && !line.includes('try') && !content.slice(Math.max(0, content.indexOf(line) - 200), content.indexOf(line)).includes('try {')) {
      // Check surrounding context
      const prevLines = lines.slice(Math.max(0, i - 5), i).join('\n');
      if (!prevLines.includes('try {') && !line.includes('try')) {
        issues.push({
          file: rel,
          line: i + 1,
          severity: 'MEDIUM',
          type: 'UNHANDLED_CRASH',
          message: `JSON.parse on localStorage without try/catch: line ${i + 1}`,
          code: line.trim(),
        });
      }
    }
  });

  // 5. Check for dangerous any casts or potential null dereferences
  lines.forEach((line, i) => {
    if (line.includes('.forEach(') && !line.includes('?.forEach') && !line.includes('if (') && line.match(/\b([a-zA-Z0-9_]+)\.forEach\(/)) {
      // potential undefined.forEach if variable can be undefined
    }
  });
}

scanDir(SRC_DIR);

console.log(`Scan complete! Found ${issues.length} potential issues:`);
console.table(issues.map(i => ({ file: i.file, line: i.line || '-', type: i.type, severity: i.severity, message: i.message })));

