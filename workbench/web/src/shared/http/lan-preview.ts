export const lanPreviewMode = 'lan-preview'
export const lanPreviewHeader = 'x-ursi-lan-preview'

export function isLanPreview() {
  return import.meta.env.MODE === lanPreviewMode
}
