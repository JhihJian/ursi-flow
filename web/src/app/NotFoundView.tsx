import { Link } from 'react-router'

import { Icon } from '@/shared/ui/icon'

export default function NotFoundView() {
  return (
    <section className="panel px-6 py-20 text-center">
      <Icon name="search" size={32} className="mx-auto mb-6 text-accent-2" />
      <p className="text-xs font-medium tracking-widest text-txt3">404 / PAGE NOT FOUND</p>
      <h1 className="mt-4 text-2xl font-semibold">页面未找到</h1>
      <p className="mt-4 text-sm text-txt3">这个地址不存在，请检查链接或返回 Flow 目录。</p>
      <Link to="/flows" className="mt-8 inline-flex rounded-lg bg-accent px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-accent-hover">
        返回 Flow 目录
      </Link>
    </section>
  )
}
