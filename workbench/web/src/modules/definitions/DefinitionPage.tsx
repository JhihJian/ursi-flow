import { useParams } from 'react-router'
import type { Collection } from './catalog'
import { Editor } from './Editor'
import { Detail, Directory, History } from './Views'

export type Page = 'directory' | 'detail' | 'history' | 'editor'
export function DefinitionPage({ k, page }: { k: Collection; page: Page }) {
  const { id, revision } = useParams()
  const key = JSON.stringify([k, page, id, revision])
  if (page === 'editor') return <Editor key={key} k={k} id={id} revision={revision} />
  if (page === 'history' && id) return <History key={key} k={k} id={id} />
  if (page === 'detail' && id) return <Detail key={key} k={k} id={id} revision={revision} />
  return <Directory key={key} k={k} />
}
