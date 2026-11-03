// Frames run the source's own scripts with its own cookies, and links inside
// them open ordinary tabs. Nothing gets top navigation, forms or downloads.
export const FRAME = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';
export const VIDEO = `${FRAME} allow-presentation`;
