import icons from './icons.json'

export type IconName = keyof typeof icons
export const resolveIcon = (name: string) => Object.hasOwn(icons, name) ? icons[name as IconName] : icons.dot
