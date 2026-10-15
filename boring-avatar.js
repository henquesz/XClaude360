// Avatar no estilo "beam" do Boring Avatars (https://boringavatars.com), portado do original em React
// para gerar o SVG direto, sem dependências. Licença do original: MIT, (c) Josep Martins.
// Mesmo nome + mesmas cores = mesmo avatar, então basta guardar a semente e a paleta no perfil.

const SIZE = 36;

export const PALETTES = [
  ['#92A1C6', '#146A7C', '#F0AB3D', '#C271B4', '#C20D90'], // padrão do Boring Avatars
  ['#0a0310', '#49007e', '#ff005b', '#ff7d10', '#ffb238'],
  ['#1aa41a', '#0f8c0f', '#e8f5e8', '#2b2b2b', '#9be59b'], // verde do dashboard
  ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
  ['#0d1b2a', '#1b263b', '#415a77', '#778da9', '#e0e1dd'],
  ['#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff'],
  ['#2b2d42', '#8d99ae', '#edf2f4', '#ef233c', '#d90429'],
  ['#006d77', '#83c5be', '#edf6f9', '#ffddd2', '#e29578'],
];

const getNumber = (name) => Array.from(name).reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
const getDigit = (number, ntn) => Math.floor((number / Math.pow(10, ntn)) % 10);
const getBoolean = (number, ntn) => !(getDigit(number, ntn) % 2);
const getUnit = (number, range, index) => {
  const value = number % range;
  return index && getDigit(number, index) % 2 === 0 ? -value : value;
};
const getColor = (number, colors) => colors[number % colors.length];
const getContrast = (hex) => {
  const h = hex.replace('#', '');
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#FFFFFF';
};

function beamData(name, colors) {
  const num = getNumber(name);
  const wrapperColor = getColor(num, colors);
  const preTranslateX = getUnit(num, 10, 1);
  const wrapperTranslateX = preTranslateX < 5 ? preTranslateX + SIZE / 9 : preTranslateX;
  const preTranslateY = getUnit(num, 10, 2);
  const wrapperTranslateY = preTranslateY < 5 ? preTranslateY + SIZE / 9 : preTranslateY;
  return {
    wrapperColor,
    faceColor: getContrast(wrapperColor),
    backgroundColor: getColor(num + 13, colors),
    wrapperTranslateX,
    wrapperTranslateY,
    wrapperRotate: getUnit(num, 360),
    wrapperScale: 1 + getUnit(num, SIZE / 12) / 10,
    isMouthOpen: getBoolean(num, 2),
    isCircle: getBoolean(num, 1),
    eyeSpread: getUnit(num, 5),
    mouthSpread: getUnit(num, 3),
    faceRotate: getUnit(num, 10, 3),
    faceTranslateX: wrapperTranslateX > SIZE / 6 ? wrapperTranslateX / 2 : getUnit(num, 8, 1),
    faceTranslateY: wrapperTranslateY > SIZE / 6 ? wrapperTranslateY / 2 : getUnit(num, 7, 2),
  };
}

let maskCounter = 0;

// Retorna o SVG como texto. square = cantos retos (como a gamerpic do 360) em vez de círculo.
export function avatarSvg(name, colors = PALETTES[0], { size = 80, square = false, title = '' } = {}) {
  const d = beamData(name || ' ', colors);
  const maskId = `ba-mask-${++maskCounter}`;
  const half = SIZE / 2;
  const mouth = d.isMouthOpen
    ? `<path d="M15 ${19 + d.mouthSpread}c2 1 4 1 6 0" stroke="${d.faceColor}" fill="none" stroke-linecap="round"/>`
    : `<path d="M13,${19 + d.mouthSpread} a1,0.75 0 0,0 10,0" fill="${d.faceColor}"/>`;
  return `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" role="img" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
    (title ? `<title>${escapeXml(title)}</title>` : '') +
    `<mask id="${maskId}" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" ${square ? '' : `rx="${SIZE * 2}"`} fill="#FFFFFF"/></mask>` +
    `<g mask="url(#${maskId})">` +
    `<rect width="${SIZE}" height="${SIZE}" fill="${d.backgroundColor}"/>` +
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" transform="translate(${d.wrapperTranslateX} ${d.wrapperTranslateY}) rotate(${d.wrapperRotate} ${half} ${half}) scale(${d.wrapperScale})" fill="${d.wrapperColor}" rx="${d.isCircle ? SIZE : SIZE / 6}"/>` +
    `<g transform="translate(${d.faceTranslateX} ${d.faceTranslateY}) rotate(${d.faceRotate} ${half} ${half})">` +
    mouth +
    `<rect x="${14 - d.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${d.faceColor}"/>` +
    `<rect x="${20 + d.eyeSpread}" y="14" width="1.5" height="2" rx="1" stroke="none" fill="${d.faceColor}"/>` +
    `</g></g></svg>`;
}

// Semente aleatória curta (o avatar depende só dela e da paleta)
export function randomSeed() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('');
}

function escapeXml(text) {
  return String(text).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' })[c]);
}
