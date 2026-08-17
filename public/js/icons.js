// All icons of the UI as inline SVG.
//
// Inline SVG instead of emoji or special characters: on this UI, characters
// have repeatedly shown up as empty boxes because they were missing from the
// device's font - most recently the screen icon above the terminal on the
// desktop. An SVG doesn't depend on any font and takes on the button's color
// via currentColor.
//
// Exempt from this are the key labels on the keybar (Esc, Tab, ^C, the
// arrows): those are names of keys, not icons, and the keybar only exists on
// the phone - there they've been verified in actual use.

// Drawn for viewBox 0 0 16 16, stroke width 1.3. Anyone adding to this stays
// with outlines: the fill comes from the stroke (fill="none"); only where a
// filled area is actually intended does the path set it itself.
export const ICONS = {
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  file: '<path d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"/><path d="M9 2v3h3"/>',
  image: '<rect x="2.5" y="3.5" width="11" height="9" rx="1"/><circle cx="6" cy="6.5" r="1"/><path d="M3 11l3-3 2.5 2.5L11 8l2 2"/>',
  reload: '<path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.9"/><path d="M13.5 2.5V5H11"/>',
  download: '<path d="M8 2.5v8"/><path d="M5 7.5 8 10.5l3-3"/><path d="M3 13h10"/>',
  // The arrow points at a line rather than away from one: pulling a new
  // version up, not saving a file down.
  update: '<path d="M8 13.5v-8"/><path d="M5 8.5 8 5.5l3 3"/><path d="M3.5 3h9"/>',
  share: '<path d="M8 10.5v-8"/><path d="M5 5.5 8 2.5l3 3"/><path d="M3.5 8.5v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-4"/>',
  pencil: '<path d="M11.2 2.8a1.4 1.4 0 0 1 2 2L5.6 12.4 3 13l.6-2.6z"/>',
  // Window with a prompt instead of a monitor-on-a-stand: this means the
  // console, not the device.
  terminal: '<rect x="1.9" y="2.6" width="12.2" height="10.8" rx="1.5"/><path d="M4.7 6.6 7 8.9l-2.3 2.3"/><path d="M8.6 11.3h3"/>',
  warning: '<path d="M8 2.4 14.3 13.2H1.7z"/><path d="M8 6.6v3"/><path d="M8 11.2h.01"/>',
  // The three below label the markdown alerts in the Files tab (note, tip,
  // important); warning and forbidden above carry the other two.
  info: '<circle cx="8" cy="8" r="5.9"/><path d="M8 7.4v3.8"/><path d="M8 5h.01"/>',
  bulb: '<path d="M5.4 9.2a3.5 3.5 0 1 1 5.2 0c-.6.6-.9 1.2-1 2H6.4c-.1-.8-.4-1.4-1-2z"/><path d="M6.6 13.4h2.8"/>',
  important: '<path d="M2.5 4a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5.4a1 1 0 0 1-1 1H6.6L4 13.1v-2.7h-.5a1 1 0 0 1-1-1z"/><path d="M8 5.2v2.3"/><path d="M8 9.1h.01"/>',
  forbidden: '<circle cx="8" cy="8" r="5.9"/><path d="m4.2 4.2 7.6 7.6"/>',
  hourglass: '<path d="M4.4 2.4h7.2"/><path d="M4.4 13.6h7.2"/><path d="M5.4 2.4v2.4L8 7.6l2.6-2.8V2.4"/><path d="M5.4 13.6v-2.4L8 8.4l2.6 2.8v2.4"/>',
  key: '<circle cx="10.5" cy="5.5" r="2.9"/><path d="M8.4 7.6 2.7 13.3"/><path d="m4.5 11.5 1.6 1.6"/>',
  person: '<circle cx="8" cy="5.4" r="2.6"/><path d="M2.9 13.4a5.1 5.1 0 0 1 10.2 0"/>',
  star: '<path d="M8 2.2 9.5 6.14 13.71 6.35 10.43 8.99 11.53 13.05 8 10.75 4.47 13.05 5.57 8.99 2.29 6.35 6.5 6.14Z"/>',
  starFull: '<path d="M8 2.2 9.5 6.14 13.71 6.35 10.43 8.99 11.53 13.05 8 10.75 4.47 13.05 5.57 8.99 2.29 6.35 6.5 6.14Z" fill="currentColor"/>',
  close: '<path d="m4.2 4.2 7.6 7.6"/><path d="m11.8 4.2-7.6 7.6"/>',
  bell: '<path d="M4.4 6.8a3.6 3.6 0 0 1 7.2 0v3l1.2 1.8H3.2L4.4 9.8z"/><path d="M6.6 13a1.6 1.6 0 0 0 2.8 0"/>',
  plus: '<path d="M8 3.4v9.2"/><path d="M3.4 8h9.2"/>',
  back: '<path d="M10 3.4 5.4 8 10 12.6"/>',
  // Same shape as `back`, under its own name: it marks the expandable folder
  // in the file tree and is rotated by CSS, where a "back" arrow on a folder
  // would read as a mistake.
  chevron: '<path d="M6 3.4 10.6 8 6 12.6"/>',
  power: '<path d="M12.2 4.4a6 6 0 1 1-8.4 0"/><path d="M8 1.4v6.6"/>',
  // Arrow pointing at a stop - the direction shows where the sidebar goes.
  collapse: '<path d="M13.4 8H5.2"/><path d="M8.2 4.8 5 8l3.2 3.2"/><path d="M2.6 3.6v8.8"/>',
  expand: '<path d="M2.6 8h8.2"/><path d="M7.8 4.8 11 8l-3.2 3.2"/><path d="M13.4 3.6v8.8"/>',
};

export function svg(name, className = '') {
  return `<svg class="${className}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;
}

// For places where the adjoining text comes from the filesystem or from an
// account: nothing there may go through innerHTML, the icon has to arrive as
// a ready-made node next to a text node.
export function svgNode(name, className = '') {
  const template = document.createElement('template');
  template.innerHTML = svg(name, className);
  return template.content.firstElementChild;
}
