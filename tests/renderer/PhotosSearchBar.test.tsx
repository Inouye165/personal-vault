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

  it('displays clear recovery guidance when the model status is corrupt or error', () => {
    const { rerender } = render(
      <PhotosSearchBar
        query="mountain"
        isSearching={false}
        modelStatus="corrupt"
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByText(/offline search model is invalid or damaged/i)).toBeInTheDocument()
    expect(screen.getByText(/re-download or re-import the verified model/i)).toBeInTheDocument()

    rerender(
      <PhotosSearchBar
        query="mountain"
        isSearching={false}
        modelStatus="error"
        onSearch={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByText(/offline search model is invalid or damaged/i)).toBeInTheDocument()
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
})
