import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PhotosSearchBar } from '../../src/renderer/src/components/PhotosSearchBar'

describe('Stage 6D: PhotosSearchBar UI Component', () => {
  it('renders search input, search button, and placeholder', () => {
    const onSearch = vi.fn()
    const onClear = vi.fn()

    render(
      <PhotosSearchBar
        query=""
        isSearching={false}
        modelStatus="ready"
        onSearch={onSearch}
        onClear={onClear}
      />
    )

    const input = screen.getByPlaceholderText(/search photos by description/i)
    expect(input).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /search/i })).toBeInTheDocument()
  })

  it('triggers search when submitting input or clicking search button', () => {
    const onSearch = vi.fn()
    const onClear = vi.fn()

    render(
      <PhotosSearchBar
        query=""
        isSearching={false}
        modelStatus="ready"
        onSearch={onSearch}
        onClear={onClear}
      />
    )

    const input = screen.getByPlaceholderText(/search photos by description/i)
    fireEvent.change(input, { target: { value: 'sunset at beach' } })

    const form = input.closest('form')!
    fireEvent.submit(form)

    expect(onSearch).toHaveBeenCalledWith('sunset at beach')
  })

  it('provides a clear button that clears query and restores ordinary browsing', () => {
    const onSearch = vi.fn()
    const onClear = vi.fn()

    render(
      <PhotosSearchBar
        query="mountain"
        isSearching={false}
        modelStatus="ready"
        searchResult={{
          totalMatched: 5,
          eligibleCount: 10,
          unindexedCount: 0,
          staleCount: 0,
          truncated: false,
          tokenCount: 3,
          queryLatencyMs: 12
        }}
        onSearch={onSearch}
        onClear={onClear}
      />
    )

    const clearBtn = screen.getByRole('button', { name: /clear search/i })
    expect(clearBtn).toBeInTheDocument()
    fireEvent.click(clearBtn)

    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('displays an honest message when the semantic model is not installed', () => {
    render(
      <PhotosSearchBar
        query=""
        isSearching={false}
        modelStatus="unprovisioned"
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByText(/offline search model is not installed/i)).toBeInTheDocument()
  })

  it('displays partial indexing warning and long-query truncation warning', () => {
    render(
      <PhotosSearchBar
        query="long search query"
        isSearching={false}
        modelStatus="ready"
        searchResult={{
          totalMatched: 3,
          eligibleCount: 20,
          unindexedCount: 15,
          staleCount: 2,
          truncated: true,
          tokenCount: 77,
          queryLatencyMs: 18
        }}
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    // Match count badge
    expect(screen.getByText(/3 semantic matches/i)).toBeInTheDocument()
    // Partial coverage note
    expect(screen.getByText(/15 unindexed/i)).toBeInTheDocument()
    // Truncation notice
    expect(screen.getByText(/query truncated to 77 tokens/i)).toBeInTheDocument()
  })

  it('distinguishes a verified corrupt installed model from a download/setup failure notice', () => {
    const { rerender } = render(
      <PhotosSearchBar
        query="mountain"
        isSearching={false}
        modelStatus="corrupt"
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('search-model-corrupt-notice')).toBeInTheDocument()
    expect(screen.getByText(/offline search model is invalid or damaged/i)).toBeInTheDocument()
    expect(screen.getByText(/re-download or re-import the verified model/i)).toBeInTheDocument()
    expect(screen.queryByTestId('search-model-error-notice')).not.toBeInTheDocument()

    rerender(
      <PhotosSearchBar
        query="mountain"
        isSearching={false}
        modelStatus="error"
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByTestId('search-model-error-notice')).toBeInTheDocument()
    expect(screen.getByText(/download or setup failed/i)).toBeInTheDocument()
    expect(screen.queryByText(/invalid or damaged/i)).not.toBeInTheDocument()
  })

  it('displays corrupt candidate warning with reindex guidance when corruptCount > 0', () => {
    render(
      <PhotosSearchBar
        query="sunset"
        isSearching={false}
        modelStatus="ready"
        searchResult={{
          totalMatched: 4,
          eligibleCount: 10,
          unindexedCount: 0,
          staleCount: 0,
          corruptCount: 2,
          truncated: false,
          tokenCount: 2,
          queryLatencyMs: 9
        }}
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const warning = screen.getByTestId('search-corrupt-warning')
    expect(warning).toHaveTextContent(/2 damaged \(reindex recommended\)/i)
  })

  it('formats search timing compactly without raw token diagnostics in primary UI', () => {
    render(
      <PhotosSearchBar
        query="ocean"
        isSearching={false}
        modelStatus="ready"
        searchResult={{
          totalMatched: 7,
          eligibleCount: 20,
          unindexedCount: 0,
          staleCount: 0,
          truncated: false,
          tokenCount: 4,
          queryLatencyMs: 240
        }}
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByText(/0\.2s/i)).toBeInTheDocument()
    expect(screen.queryByText(/240\s*ms/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/4\s*tokens/i)).not.toBeInTheDocument()
  })

  it('uses an accessible icon-only clear button outside the editable text area', () => {
    render(
      <PhotosSearchBar
        query="golden hour"
        isSearching={false}
        modelStatus="ready"
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const clearBtn = screen.getByRole('button', { name: /clear search/i })
    expect(clearBtn).toBeInTheDocument()
    expect(clearBtn.textContent?.trim()).toBe('')
  })
})
