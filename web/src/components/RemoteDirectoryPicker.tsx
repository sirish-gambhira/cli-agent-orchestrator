import { useEffect, useState } from 'react'
import { ChevronRight, Folder, GitBranch, Home, RefreshCw, X } from 'lucide-react'
import { api, RemoteDirectoryListing } from '../api'

interface Props {
  node: string
  initialPath?: string
  onSelect: (path: string) => void
  onClose: () => void
}

export function RemoteDirectoryPicker({ node, initialPath, onSelect, onClose }: Props) {
  const [requestedPath, setRequestedPath] = useState(initialPath || '~')
  const [listing, setListing] = useState<RemoteDirectoryListing | null>(null)
  const [includeHidden, setIncludeHidden] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const load = (path: string) => {
    setLoading(true)
    setError('')
    api.browseFleetDirectories(node, path, includeHidden)
      .then(result => {
        setListing(result)
        setRequestedPath(result.path)
      })
      .catch(err => setError(err.detail || err.message || 'Could not browse directory'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(initialPath || '~') }, [node, includeHidden])

  const breadcrumbs = listing?.path.split('/').filter(Boolean) || []

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden">
        <div className="flex items-center justify-between p-5 border-b border-gray-700/50">
          <div>
            <h3 className="text-base font-semibold text-gray-200">Choose directory</h3>
            <p className="text-xs text-blue-300 mt-1 font-mono">{node}</p>
          </div>
          <button onClick={onClose} className="p-1.5 text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-3">
          <div className="flex gap-2">
            <input
              value={requestedPath}
              onChange={event => setRequestedPath(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && load(requestedPath)}
              className="flex-1 bg-gray-900 border border-gray-700 text-gray-200 text-sm font-mono rounded-lg px-3 py-2 focus:border-emerald-500 focus:outline-none"
              aria-label="Remote directory path"
            />
            <button onClick={() => load(requestedPath)} className="px-3 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm">Go</button>
          </div>

          <div className="flex items-center gap-1 text-xs text-gray-500 overflow-x-auto min-h-7">
            <button onClick={() => listing && load(listing.home)} className="p-1.5 hover:text-emerald-400" title="Home"><Home size={14} /></button>
            <button onClick={() => listing && load(listing.path)} className="p-1.5 hover:text-emerald-400" title="Refresh"><RefreshCw size={14} /></button>
            <button onClick={() => load('/')} className="hover:text-gray-200">/</button>
            {breadcrumbs.map((part, index) => (
              <span key={`${part}-${index}`} className="flex items-center">
                <ChevronRight size={12} />
                <button onClick={() => load(`/${breadcrumbs.slice(0, index + 1).join('/')}`)} className="hover:text-gray-200 whitespace-nowrap">{part}</button>
              </span>
            ))}
          </div>

          <div className="h-72 overflow-y-auto bg-gray-900/60 border border-gray-700/50 rounded-lg">
            {loading ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-500">Loading directories…</div>
            ) : error ? (
              <div className="p-4 text-sm text-red-400">{error}</div>
            ) : (
              <>
                {listing?.parent && (
                  <button onClick={() => load(listing.parent!)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-800 text-gray-400 border-b border-gray-800">
                    <Folder size={15} /><span className="font-mono text-sm">..</span>
                  </button>
                )}
                {listing?.entries.map(entry => (
                  <button key={entry.path} onClick={() => load(entry.path)} className="w-full flex items-center justify-between px-4 py-2.5 text-left hover:bg-gray-800 border-b border-gray-800/60 last:border-0">
                    <span className="flex items-center gap-3 min-w-0">
                      <Folder size={15} className="text-blue-400 shrink-0" />
                      <span className="font-mono text-sm text-gray-300 truncate">{entry.name}</span>
                    </span>
                    {entry.is_git_repository && (
                      <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-900/30 px-2 py-0.5 rounded">
                        <GitBranch size={10} />{entry.is_worktree ? 'worktree' : 'git'}
                      </span>
                    )}
                  </button>
                ))}
                {!listing?.entries.length && <div className="p-4 text-sm text-gray-600">No child directories</div>}
              </>
            )}
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={includeHidden} onChange={event => setIncludeHidden(event.target.checked)} />
              Show hidden directories
            </label>
            {listing?.is_git_repository && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <GitBranch size={12} /> {listing.git_branch || (listing.is_worktree ? 'worktree' : 'Git repository')}
              </span>
            )}
          </div>
          {listing?.truncated && <p className="text-xs text-amber-400">Showing the first 500 directories.</p>}
        </div>

        <div className="flex justify-end gap-3 p-5 border-t border-gray-700/50">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button
            onClick={() => listing && onSelect(listing.path)}
            disabled={!listing || loading}
            className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg"
          >
            Select this directory
          </button>
        </div>
      </div>
    </div>
  )
}
