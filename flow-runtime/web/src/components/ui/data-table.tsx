// 数据表格：列定义交给调用方，这里只负责排序、筛选与分页的骨架。
// 采用 TanStack Table v9 的 headless API，标记与样式仍用本目录的 shadcn Table。
import { useEffect, useState } from 'react'
import {
  columnFilteringFeature,
  type ColumnDef,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  type RowData,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, Search } from 'lucide-react'
import { Button } from './button'
import { Empty, EmptyContent, EmptyMedia, EmptyTitle } from './empty'
import { Input } from './input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './table'

/** 列级样式：窄屏用它可以隐藏次要列，而不是让整张表横向滚动。 */
export interface DataTableColumnMeta {
  className?: string
  cellClassName?: string
}

const metaOf = (definition: { meta?: unknown }) =>
  (definition.meta ?? {}) as DataTableColumnMeta

// 特性与行模型在模块作用域注册一次，表格实例不会因为重渲染而重建。
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortedRowModel: createSortedRowModel(),
  filterFns: { includesString: filterFn_includesString },
  sortFns: { alphanumeric: sortFn_alphanumeric, text: sortFn_text },
})

export type DataTableColumn<TData extends RowData> = ColumnDef<
  typeof dataTableFeatures,
  TData
>

export function DataTable<TData extends RowData>({
  columns,
  data,
  filterPlaceholder,
  countLabel,
  emptyTitle = '暂无数据',
  emptyAction,
  /** 值变化时清空筛选，供调用方在删除行后回到完整列表。 */
  filterResetKey,
  pageSize = 20,
}: {
  columns: DataTableColumn<TData>[]
  data: TData[]
  filterPlaceholder: string
  /** 命中数与总数的说法，例如 `个包`。 */
  countLabel: string
  emptyTitle?: string
  emptyAction?: React.ReactNode
  filterResetKey?: number
  pageSize?: number
}) {
  const [globalFilter, setGlobalFilter] = useState('')
  const table = useTable({
    features: dataTableFeatures,
    columns,
    data,
    state: { globalFilter },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: 'includesString',
    initialState: { pagination: { pageIndex: 0, pageSize } },
  })
  useEffect(() => {
    if (filterResetKey === undefined) return
    setGlobalFilter('')
  }, [filterResetKey])
  const rows = table.getRowModel().rows
  const matched = table.getFilteredRowModel().rows.length
  const pageCount = table.getPageCount()
  const pageIndex = table.atoms.pagination.get().pageIndex
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8"
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
            placeholder={filterPlaceholder}
            aria-label={filterPlaceholder}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          {globalFilter.trim()
            ? `${matched} / ${data.length} ${countLabel}`
            : `共 ${data.length} ${countLabel}`}
        </p>
      </div>
      {!rows.length ? (
        <Empty>
          <EmptyMedia>
            <Search />
          </EmptyMedia>
          <EmptyTitle>{globalFilter.trim() ? '没有匹配的记录' : emptyTitle}</EmptyTitle>
          {globalFilter.trim() ? (
            <EmptyContent>
              <Button variant="ghost" size="sm" onClick={() => setGlobalFilter('')}>
                清除筛选
              </Button>
            </EmptyContent>
          ) : (
            emptyAction && <EmptyContent>{emptyAction}</EmptyContent>
          )}
        </Empty>
      ) : (
        <>
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => {
                    const sortable = header.column.getCanSort()
                    const sorted = header.column.getIsSorted()
                    return (
                      <TableHead key={header.id} className={metaOf(header.column.columnDef).className}>
                        {header.isPlaceholder ? null : sortable ? (
                          <button
                            type="button"
                            className="-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground"
                            onClick={header.column.getToggleSortingHandler()}
                            aria-label={`按${typeof header.column.columnDef.header === 'string' ? header.column.columnDef.header : '该列'}排序`}
                          >
                            <table.FlexRender header={header} />
                            {sorted === 'asc' ? (
                              <ArrowUp className="size-3" />
                            ) : sorted === 'desc' ? (
                              <ArrowDown className="size-3" />
                            ) : (
                              <ChevronsUpDown className="size-3 opacity-50" />
                            )}
                          </button>
                        ) : (
                          <table.FlexRender header={header} />
                        )}
                      </TableHead>
                    )
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={metaOf(cell.column.columnDef).cellClassName}
                    >
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {pageCount > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                第 {pageIndex + 1} / {pageCount} 页
              </span>
              <span className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!table.getCanPreviousPage()}
                  onClick={() => table.previousPage()}
                >
                  <ChevronLeft />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!table.getCanNextPage()}
                  onClick={() => table.nextPage()}
                >
                  下一页
                  <ChevronRight />
                </Button>
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
