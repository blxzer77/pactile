let warned = false;

export function warnLegacyCliOnce(): void {
  if (warned) return;
  warned = true;
  process.stderr.write(
    '[pactile] Deprecated compatibility entry: use "pactile" from ' +
      '@blxzer/pactile; the "cstl" and @blxzer/cursor-trellis aliases ' +
      'remain only through 0.5.x.\n',
  );
}
