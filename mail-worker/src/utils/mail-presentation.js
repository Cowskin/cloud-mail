import parse from 'css-tree/parser';
import generate from 'css-tree/generator';
import walk from 'css-tree/walker';

// Reviewed, generic Apple email artwork only. Never load arbitrary remote, CID,
// data, QR or personalized images while protection is enabled.
const appleArtwork = new Set([
  '/rover/aos/moe/apple_icon_2x.png', '/rover/aos/egc/gc_def_hero_lg.jpg',
  ...['mac', 'iphone', 'ipad', 'watch', 'accessories'].map(name => `/rover/aos/moe/icon-${name}.png`),
  ...['appstore', 'tv', 'arcade', 'itunes', 'icloud_v2', 'news_v2', 'books'].map(name => `/rover/aos/moe/icon-${name}.jpg`),
  ...['music-2', 'appleone', 'fitness'].map(name => `/rover/aos/moe/icon-${name}.png`),
  '/dm/groups/aos/om/global/cmon/spacer.gif'
]);

export function safeArtwork(source) {
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.hostname !== 'email.images.apple.com' ||
        url.port || url.username || url.password || url.search || url.hash || !appleArtwork.has(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

const properties = new Set(`display visibility opacity width min-width max-width height min-height max-height
  margin margin-top margin-right margin-bottom margin-left margin-inline margin-block
  padding padding-top padding-right padding-bottom padding-left padding-inline padding-block
  border border-top border-right border-bottom border-left border-width border-style border-color
  border-top-width border-right-width border-bottom-width border-left-width border-top-style border-right-style
  border-bottom-style border-left-style border-top-color border-right-color border-bottom-color border-left-color
  border-collapse border-spacing border-radius border-top-left-radius border-top-right-radius
  border-bottom-left-radius border-bottom-right-radius box-sizing box-shadow outline outline-width outline-style outline-color
  color background background-color background-repeat font font-family font-size font-weight font-style font-variant
  line-height letter-spacing word-spacing text-align text-decoration text-decoration-color text-decoration-line
  text-decoration-style text-indent text-transform text-size-adjust -webkit-text-size-adjust white-space
  vertical-align word-break overflow-wrap overflow overflow-x overflow-y table-layout caption-side empty-cells
  list-style-type list-style-position direction unicode-bidi float clear position top right bottom left
  flex flex-direction flex-wrap flex-grow flex-shrink flex-basis justify-content align-items align-content align-self
  gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row
  mso-hide mso-table-lspace mso-table-rspace -moz-border-radius -webkit-border-radius -moz-box-shadow -webkit-box-shadow`
  .split(/\s+/).filter(Boolean));
const functions = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'min', 'max', 'clamp', 'linear-gradient', 'radial-gradient']);
const decodeCss = text => text.replace(/\\([0-9a-f]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n])/gi,
  (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : char);
const unsafe = (text, containsCard) => /[<>]/.test(text) || containsCard(decodeCss(text));

// Parse CSS rather than searching for literal "url(". Escapes, comments,
// @import, custom properties, attr(), image-set(), expression() and raw parser
// recovery nodes must not provide a second channel for original card data.
export function presentationCss(source, inline, containsCard) {
  try {
    const ast = parse(source, { context: inline ? 'declarationList' : 'stylesheet' });
    walk(ast, {
      enter(node, item, list) {
        if (node.type === 'Atrule' && (node.name.toLowerCase() !== 'media' || !node.block ||
            !node.prelude || unsafe(generate(node.prelude), containsCard))) {
          list.remove(item); return this.skip;
        }
        if (node.type === 'Rule' && (!node.prelude || node.prelude.type !== 'SelectorList' ||
            unsafe(generate(node.prelude), containsCard) || /:host|::slotted|::part/i.test(decodeCss(generate(node.prelude))))) {
          list.remove(item); return this.skip;
        }
        if (node.type === 'Declaration') {
          let valid = properties.has(decodeCss(node.property).toLowerCase()) && !unsafe(generate(node.value), containsCard);
          walk(node.value, value => {
            if (['Url', 'Raw', 'Atrule', 'Declaration'].includes(value.type) ||
                (value.type === 'Function' && !functions.has(decodeCss(value.name).toLowerCase()))) valid = false;
          });
          if (!valid) list.remove(item);
          return this.skip;
        }
        if (node.type === 'TypeSelector' && ['body', 'html'].includes(node.name.toLowerCase())) {
          node.type = 'ClassSelector'; node.name = `cm-mail-${node.name.toLowerCase()}`;
        } else if (node.type === 'PseudoClassSelector' && node.name.toLowerCase() === 'root') {
          node.type = 'ClassSelector'; node.name = 'cm-mail-html'; delete node.children;
        } else if (node.type === 'Raw' && list) {
          list.remove(item); return this.skip;
        }
      }
    });
    return generate(ast);
  } catch { return ''; }
}
