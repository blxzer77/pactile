let warned = false;

export function warnLegacyCliOnce(): void {
  if (warned) return;
  warned = true;
  process.stderr.write(
    '[pactile] Deprecated CLI entry: use "pactile" instead of "cstl".\n',
  );
}
