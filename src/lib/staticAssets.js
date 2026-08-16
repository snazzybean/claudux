// Minifies the JS and CSS under public/ on the way out and takes the
// comments off the HTML, keeping the deploy flow that the rest of the
// project relies on: public/ is edited in place
// and a browser reload is enough, so there is no build step whose output
// could go stale. The cost is one esbuild pass per file per change, cached
// in memory afterwards.
//
// Every transform falls back to the original bytes on failure. A minifier
// that chokes on one module must not be able to take the interface down -
// that would cost the only way back into a running instance.
import fs from 'node:fs';
import path from 'node:path';
import { transformSync } from 'esbuild';

const LOADERS = { '.js': 'js', '.css': 'css', '.html': 'html' };

// Only the comments come off the HTML: collapsing whitespace or minifying
// the inline script risks the one file that carries the whole page, for
// about a kilobyte. Hand-written rather than a dependency, because the only
// hard part is that a `<!--` inside a script or style element is content,
// not a comment - cutting from there to the next `-->` would delete live
// code.
function stripHtmlComments(source) {
  const html = source.toString('utf8');
  let out = '';
  let i = 0;
  while (i < html.length) {
    const raw = /<(script|style)\b/i.exec(html.slice(i));
    const comment = html.indexOf('<!--', i);
    // Whichever comes first decides: a comment before the next script is a
    // real comment, a script before the next comment protects what's inside.
    if (comment !== -1 && (!raw || comment < i + raw.index)) {
      const end = html.indexOf('-->', comment);
      if (end === -1) break; // unterminated - leave the rest untouched
      out += html.slice(i, comment);
      i = end + 3;
    } else if (raw) {
      const tag = raw[1];
      const start = i + raw.index;
      const close = html.toLowerCase().indexOf(`</${tag.toLowerCase()}>`, start);
      if (close === -1) break;
      out += html.slice(i, close);
      i = close;
    } else {
      break;
    }
  }
  return Buffer.from(out + html.slice(i));
}

function minify(source, loader) {
  if (loader === 'html') {
    try {
      return stripHtmlComments(source);
    } catch {
      return source;
    }
  }
  try {
    return Buffer.from(transformSync(source.toString('utf8'), { loader, minify: true }).code);
  } catch {
    return source;
  }
}

export function minifyStatic(root) {
  const rootPath = path.resolve(root);
  // Keyed by absolute path, invalidated by mtime and size together: mtime
  // alone can repeat within one filesystem tick on a quick edit.
  const cache = new Map();

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // The interface is opened at "/", where express.static would resolve the
    // index itself - so this has to resolve it too, or the one file whose
    // comments this strips is the one file that keeps them.
    const urlPath = req.path.endsWith('/') ? `${req.path}index.html` : req.path;
    const loader = LOADERS[path.extname(urlPath)];
    if (!loader) return next();

    const filePath = path.resolve(rootPath, `.${urlPath}`);
    if (filePath !== rootPath && !filePath.startsWith(rootPath + path.sep)) return next();

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return next();
    }
    if (!stat.isFile()) return next();

    let entry = cache.get(filePath);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      entry = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        body: minify(fs.readFileSync(filePath), loader),
      };
      cache.set(filePath, entry);
    }

    res.type(path.extname(urlPath));
    // Matches what express.static sends, so the conditional request that
    // follows behaves the same as before. res.send() adds the ETag and
    // answers 304 by itself.
    res.set('Cache-Control', 'public, max-age=0');
    return res.send(entry.body);
  };
}
