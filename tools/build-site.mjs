// Builds the shop for upload:  site-src/{index.html,app.js,bg.js,style.css}  ->  site/
//   - minifies the JavaScript and CSS
//   - puts the CSS inside index.html (no extra request that blocks the first paint)
//   - adds a version to app.js / bg.js so browsers can cache them for a long time and still get every update
// Run:  cd tools && npm install && node build-site.mjs
import fs from 'fs';
import crypto from 'crypto';
import { minify } from 'terser';
import CleanCSS from 'clean-css';
const R = p => new URL('../' + p, import.meta.url).pathname;
const read = p => fs.readFileSync(R(p), 'utf8');
const mk = (name) => minify({ [name]: read('site-src/' + name) }, { compress: { passes: 2 }, mangle: true, format: { comments: false }, sourceMap: { filename: name, url: name + '.map', includeSources: true } });
const app = await mk('app.js'), bg = await mk('bg.js'), ar = await minify({ 'i18n-ar.js': read('site-src/i18n-ar.js') }, { compress: true, mangle: true, format: { comments: false } });
if (ar.error) throw ar.error;
if (app.error || bg.error) throw app.error || bg.error;
const css = new CleanCSS({ level: 2 }).minify(read('site-src/style.css'));
if (css.errors.length) throw new Error(css.errors.join('\n'));
const ver = crypto.createHash('sha1').update(app.code + bg.code + css.styles + ar.code).digest('hex').slice(0, 8);
fs.writeFileSync(R('site/i18n-ar.js'), ar.code);
fs.writeFileSync(R('site/app.js'), app.code);
fs.writeFileSync(R('site/bg.js'), bg.code);
fs.writeFileSync(R('site/app.js.map'), app.map);
fs.writeFileSync(R('site/bg.js.map'), bg.map);
fs.writeFileSync(R('site/style.css'), css.styles);
let html = read('site-src/index.html');
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>' + css.styles + '</style>');
html = html.replace(/(src="(?:app|bg)\.js)(?:\?v=\w+)?"/g, '$1?v=' + ver + '"');
html = html.replace("src=\"i18n-ar.js\"", 'src="i18n-ar.js?v=' + ver + '"');
fs.writeFileSync(R('site/index.html'), html);
const kb = n => (n / 1024).toFixed(1) + ' KB';
console.log('built version', ver, '| app.js', kb(app.code.length), '| bg.js', kb(bg.code.length), '| css', kb(css.styles.length), '| index.html', kb(html.length));
