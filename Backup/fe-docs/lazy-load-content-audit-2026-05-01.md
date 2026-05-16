# Lazy Load Content Audit - Gallery and Lore

**Last updated:** 2026-05-01
**Scope:** Frontend code inspection for high-volume, card-based content areas.
**Focus areas:** Gallery, Lore, Author Dashboard content lists, Command Center selection lists.
**Result:** Not ready for large datasets. Current implementation loads and renders full collections in several critical areas.

## 1. Executive Summary [Updated 2026-05-01]

The frontend currently has route-level lazy loading through `React.lazy` and `Suspense`, but card-based content lists do not implement data lazy loading, pagination, infinite scroll, virtualized rendering, or image lazy loading.

This means Gallery and Lore are acceptable for the current small seed dataset, but they are not safe for future large content volumes.

Current seed counts are small:

| Dataset | Current item count |
|---|---:|
| Gallery | 9 |
| Characters | 13 |
| Places | 7 |
| Technology | 19 |
| Creatures | 10 |
| Other Lore | 9 |
| Events | 12 |
| Projects | 9 |
| News | 8 |

The current dataset size hides the scalability issue. The issue will become visible when real content grows into hundreds or thousands of records.

## 2. What Already Exists [Updated 2026-05-01]

The app already lazy-loads page bundles at route level:

| Area | Status | Evidence |
|---|---|---|
| Route bundle splitting | Implemented | `src/App.tsx` imports pages with `lazy(() => import(...))`. |
| Suspense fallback | Implemented | `src/App.tsx` wraps routes with `Suspense`. |
| Discussion pagination by render count | Implemented | `DiscussionSection` slices comments and replies with load-more buttons. |
| Command Center display limiting | Partially implemented | `resolveSectionItems` can limit visible homepage cards based on settings. |

Important distinction:

Route-level lazy loading reduces initial JavaScript bundle load. It does not reduce how many Gallery or Lore records are fetched, filtered, sorted, or rendered after the page is opened.

## 3. Gallery Page Audit [Updated 2026-05-01]

### Status

Not lazy loaded for high-volume content.

### Findings

| Concern | Status | Evidence |
|---|---|---|
| Fetches all Gallery records | Not ready | `GalleryPage` calls `getGallery().then(setItems)` once on mount. |
| Service returns all Gallery records | Not ready | `getGallery()` returns `[...db.gallery]`. |
| Filters and sorts all records client-side | Not ready | `GalleryPage` filters `items`, then sorts the full filtered array. |
| Renders all filtered cards | Not ready | `filtered.map(...)` renders every matching item. |
| Uses image lazy loading | Not implemented | Gallery thumbnails use `<img src=...>` without `loading="lazy"` or `decoding="async"`. |
| Uses infinite scroll or load-more | Not implemented | No `IntersectionObserver`, cursor, page state, or "Load More" behavior exists. |
| Uses virtualization | Not implemented | No `react-window`, `@tanstack/react-virtual`, or equivalent dependency exists. |

### Risk

When Gallery grows:

- Initial page open will fetch all records.
- Search and sort will process the full collection on every render.
- The DOM will contain every matching card.
- Thumbnail images can begin loading for all rendered cards.
- Mobile performance will degrade first.

## 4. Lore Page Audit [Updated 2026-05-01]

### Status

Not lazy loaded for high-volume content.

### Findings

| Concern | Status | Evidence |
|---|---|---|
| Fetches every lore category on page mount | Not ready | `LorePage` calls `getCharacters`, `getPlaces`, `getTechnology`, `getCreatures`, `getOthers`, and `getEvents` in the same effect. |
| Services return full arrays | Not ready | Lore service functions return full arrays such as `[...db.characters]`, `[...db.places]`, and similar. |
| Inactive tabs are loaded upfront | Not ready | Opening `/lore/characters` still loads places, technology, creatures, other, and events. |
| Filters and sorts all category records client-side | Not ready | Each category builds `filteredChars`, `filteredPlaces`, `filteredTech`, `filteredCreatures`, `filteredOthers`, and `filteredEvents`. |
| Renders all active filtered cards | Not ready | Each active category uses `.map(...)` on the full filtered result. |
| Uses image lazy loading | Not implemented | Lore thumbnails use `<img src=...>` without `loading="lazy"` or `decoding="async"`. |
| Uses server pagination or cursor | Not implemented | Current services have no `page`, `limit`, `cursor`, `offset`, or `hasMore` contract. |
| Uses virtualization | Not implemented | No virtualization library or custom windowing exists. |

### Risk

Lore has higher risk than Gallery because it loads multiple categories at once. A user who only opens one category still pays the cost for all categories.

Future large content volume can cause:

- Slow page initialization.
- Unnecessary localStorage or REST payload size.
- Increased memory usage.
- UI jank during search and sort.
- High image bandwidth when many thumbnails exist.

## 5. Author Dashboard Audit [Updated 2026-05-01]

### Status

Not ready for high-volume author content management.

### Findings

| Concern | Status | Evidence |
|---|---|---|
| Loads all managed collections | Not ready | `AuthorDashboard.loadAll()` loads projects, all lore categories, gallery, and map data. |
| Lists full active collection | Not ready | `getItems().map(...)` renders all items for the selected tab. |
| No pagination or search limit | Not implemented | The management list does not slice, paginate, virtualize, or defer rendering. |

### Risk

The Author Dashboard will become a bottleneck before public pages if authors manage large archives. Edit/delete lists should not render hundreds or thousands of rows at once.

## 6. Command Center Selection Audit [Updated 2026-05-01]

### Status

Partially limited for display, but not lazy loaded for option selection.

### Findings

| Concern | Status | Evidence |
|---|---|---|
| Homepage display can limit visible cards | Partial | `resolveSectionItems` can return `all.slice(0, limit)`. |
| Source data still loaded in full | Not ready | `HomePage` calls full collection services such as `getGallery()` and `getCharacters()`. |
| Selection panel loads all options | Not ready | `CommandCenterSelectionPanel` loads all projects, news, characters, places, technology, and gallery. |
| Selection panel renders all options in scroll areas | Not ready | `options[s.key].map(...)` renders every option inside a fixed-height scroll area. |

### Risk

Command Center display is safe for current demo because it only shows a few cards, but the settings selection UI can become heavy when content grows.

## 7. Technical Classification [Updated 2026-05-01]

| Feature | Current status |
|---|---|
| Route code lazy loading | Ready |
| Card data lazy loading | Not implemented |
| Server pagination contract | Not implemented in FE services |
| Client load-more rendering | Not implemented for Gallery and Lore |
| Infinite scroll | Not implemented |
| Virtualized grid/list | Not implemented |
| Thumbnail lazy image loading | Not implemented |
| Deferred search value | Not implemented |
| Discussion load-more | Implemented only for comments/replies |

## 8. Recommended Implementation Direction [Updated 2026-05-01]

### Priority 1: REST pagination contract

Add paginated API contracts before connecting FE to production data.

Recommended response shape:

```ts
type PaginatedResponse<T> = {
  items: T[];
  pageInfo: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    nextCursor?: string;
  };
};
```

Minimum query parameters:

```txt
?page=1&pageSize=24&search=&sort=newest&type=image
```

For frequently changing content, prefer cursor pagination:

```txt
?cursor=<opaque-cursor>&limit=24&search=&sort=newest
```

### Priority 2: Gallery page load-more

Gallery should load the first page only, then append more items through a "Load More" button or intersection observer.

Recommended first-page size:

| Viewport | Page size |
|---|---:|
| Mobile | 12 |
| Tablet | 18 |
| Desktop | 24 |

### Priority 3: Lore category lazy fetch

Lore should fetch only the active category. Inactive tabs should not fetch until selected.

Recommended behavior:

- Opening `/lore/characters` fetches only characters.
- Switching to Places fetches places once.
- Switching back to Characters reuses cached data.
- Search and sort should be sent as query parameters when REST is active.

### Priority 4: Thumbnail lazy loading

Add lazy image attributes for non-critical thumbnails:

```tsx
<img
  src={item.thumbnail}
  alt={item.title}
  loading="lazy"
  decoding="async"
  className="w-full h-full object-cover"
/>
```

### Priority 5: Virtualization threshold

Use virtualized rendering when any list can exceed roughly 200 visible records.

Recommended candidates:

- Author Dashboard item list.
- Command Center selection options.
- Gallery grid if infinite scroll still leaves many mounted cards.
- Lore category grids if categories become very large.

## 9. Backend Requirement Impact [Updated 2026-05-01]

The backend requirement should preserve or add these expectations:

- All high-volume list endpoints must support pagination.
- Gallery list endpoint must support `page/pageSize` or cursor pagination, search, type filter, and sort.
- Lore list endpoints must support category-specific pagination, search, and sort.
- Author management endpoints should support pagination and search for each managed content type.
- Command Center selection endpoints should support lightweight option search, not full record payloads.
- List endpoints should return card-summary records by default, with detail endpoints returning full content.
- Thumbnail URLs should be returned separately from large media assets.

## 10. Final Assessment [Updated 2026-05-01]

Gallery and Lore are not currently protected against large data volumes.

They are demo-safe with the current small seed data, but not implementation-ready for production-scale content unless pagination, load-more behavior, lazy thumbnail loading, and category-specific data fetching are added before REST integration.
