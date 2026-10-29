const sourceRoot = new URL('../../src/', import.meta.url);

// Only application imports use this alias. tsx handles extensions/directories.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@/') && context.parentURL?.startsWith(sourceRoot.href)) {
    specifier = new URL(specifier.slice(2), sourceRoot).href;
  }
  const resolved = await nextResolve(specifier, context);
  // The app uses ES modules (tsconfig module=esnext), even though package.json
  // has no type=module. Avoid Node treating these TS sources as CommonJS.
  if (resolved.url.startsWith(sourceRoot.href) && /\.tsx?(?:\?|$)/.test(resolved.url)) {
    return { ...resolved, format: 'module' };
  }
  return resolved;
}
