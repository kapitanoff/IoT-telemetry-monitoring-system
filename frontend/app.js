// ─── Константы ───────────────────────────────────────────────
const STATUS_LABELS = {
    green:   'Норма',
    yellow:  'Предупреждение',
    red:     'Опасно',
    unknown: 'Нет данных'
};

const STATUS_PRIORITY = { red: 0, yellow: 1, unknown: 2, green: 3 };

const REFRESH_INTERVAL_MS = 3000;
const LONG_PRESS_MS = 500;
const LATENCY_GOOD_MS = 50;
const LATENCY_WARN_MS = 200;
const LOSS_GOOD = 0.01;
const LOSS_WARN = 0.05;
const PAGE_SIZE_OPTIONS = [40, 60];

// Пороги батареи (характеристика CR2032)
const BATTERY_LEVELS = [
    { min: 3.0,  icon: '🔋', cls: 'bat-full',  label: 'Заряд: полный' },
    { min: 2.7,  icon: '🔋', cls: 'bat-mid',   label: 'Заряд: средний' },
    { min: 2.4,  icon: '🪫', cls: 'bat-low',   label: 'Заряд: низкий' },
    { min: 0,    icon: '🪫', cls: 'bat-crit',  label: 'Заряд: критический!' }
];

function getBatteryLevel(voltage) {
    if (voltage == null) return null;
    for (const lvl of BATTERY_LEVELS) {
        if (voltage >= lvl.min) return lvl;
    }
    return BATTERY_LEVELS[BATTERY_LEVELS.length - 1];
}

// ─── Состояние ───────────────────────────────────────────────
let chartInstance    = null;   // текущий график Chart.js
let selectedChicken  = null;   // ID курицы открытой в модалке
let selectedHours    = 1;      // выбранный период графика

let currentPage      = 1;      // текущая страница
let totalPages       = 1;      // всего страниц
let perPage          = normalizePageSize(localStorage.getItem('chicken-page-size')); // куриц на странице
let renderedPage     = 0;      // последняя отрисованная страница

let viewMode         = 'all';  // 'all' | 'groups'
let groupsCache      = [];     // кэш списка групп
let collapsedGroups  = new Set(); // ID свёрнутых секций

let selectMode       = false;  // режим множественного выбора
let selectedChickens = new Set(); // выбранные курицы
let suppressClickChickenId = null; // click после длинного нажатия не должен снимать первый выбор

let allChickensCache = [];     // кэш всех куриц для навигации
let statusFilter     = null;   // фильтр по статусу (null = все)
let consecutiveErrors = 0;     // счётчик ошибок подряд для баннера

function normalizePageSize(value) {
    const numeric = Number(value);
    return PAGE_SIZE_OPTIONS.includes(numeric) ? numeric : 60;
}

function getGridMetrics(grid) {
    const main = document.querySelector('main');
    if (!grid || !main) return null;

    const gridStyle = getComputedStyle(grid);
    const mainStyle = getComputedStyle(main);
    const gap = parseFloat(gridStyle.columnGap || gridStyle.gap) || 10;
    const width = grid.clientWidth || main.clientWidth;
    const paddingY =
        (parseFloat(mainStyle.paddingTop) || 0) +
        (parseFloat(mainStyle.paddingBottom) || 0);
    const availableHeight = Math.max(1, main.clientHeight - paddingY);

    return { gap, width, availableHeight };
}

function getMinCellSize() {
    if (window.matchMedia('(max-width: 640px)').matches) return 104;
    if (window.matchMedia('(max-width: 900px)').matches) return 112;
    return 128;
}

function getGroupCellMaxSize() {
    if (window.matchMedia('(max-width: 640px)').matches) return null;
    if (window.matchMedia('(max-width: 900px)').matches) return 132;
    return 160;
}

function applyGridColumns(grid, itemCount, fitHeight = false) {
    if (!grid || itemCount <= 0) return;
    const metrics = getGridMetrics(grid);
    if (!metrics) return;

    const { gap, width, availableHeight } = metrics;
    const minCell = getMinCellSize();
    const maxColumns = Math.max(1, Math.min(itemCount, Math.floor((width + gap) / (minCell + gap))));
    let columns = maxColumns;

    if (fitHeight) {
        let bestColumns = maxColumns;
        let bestCell = 0;
        for (let c = 1; c <= maxColumns; c++) {
            const rows = Math.ceil(itemCount / c);
            const cellWidth = (width - gap * (c - 1)) / c;
            const totalHeight = rows * cellWidth + gap * (rows - 1);
            if (totalHeight <= availableHeight && cellWidth > bestCell) {
                bestCell = cellWidth;
                bestColumns = c;
            }
        }
        columns = bestColumns;
    }

    grid.style.setProperty('--grid-cols', String(columns));
    grid.classList.add('fit-grid');
}

function applyGroupGridColumns(grid, itemCount) {
    if (!grid || itemCount <= 0) return;
    const metrics = getGridMetrics(grid);
    if (!metrics) return;

    const { gap, width } = metrics;
    const minCell = getMinCellSize();
    const maxCell = getGroupCellMaxSize();
    const targetCell = maxCell || minCell;
    const columns = Math.max(1, Math.min(itemCount, Math.floor((width + gap) / (targetCell + gap))));
    const fittedCell = Math.max(minCell, Math.floor((width - gap * (columns - 1)) / columns));

    grid.style.setProperty('--grid-cols', String(columns));
    if (maxCell) {
        grid.style.setProperty('--grid-cell-size', `${Math.min(fittedCell, maxCell)}px`);
        grid.classList.add('compact-grid');
    } else {
        grid.style.removeProperty('--grid-cell-size');
        grid.classList.remove('compact-grid');
    }
    grid.classList.add('fit-grid');
}

function relayoutVisibleGrid() {
    const grid = document.getElementById('grid');
    if (!grid) return;
    if (viewMode === 'groups') {
        grid.querySelectorAll('.group-grid').forEach(groupGrid => {
            applyGroupGridColumns(groupGrid, groupGrid.querySelectorAll('.cell').length);
        });
        return;
    }
    applyGridColumns(grid, grid.querySelectorAll('.cell').length, true);
}

// ─── Загрузка настроек порогов ──────────────────────────────

async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        if (!res.ok) return;
        const s = await res.json();
        document.getElementById('legend-green').textContent =
            `Норма (${s.temp_green_min}–${s.temp_green_max}°C)`;
        document.getElementById('legend-yellow').textContent =
            `Предупреждение (${s.temp_green_max}–${s.temp_yellow_max}°C)`;
        document.getElementById('legend-red').textContent =
            `Опасно (<${s.temp_green_min} или >${s.temp_yellow_max}°C)`;
    } catch (err) {
        console.error('Ошибка загрузки настроек:', err);
    }
}

// ─── Загрузка групп ─────────────────────────────────────────

async function loadGroups() {
    try {
        const res = await fetch('/api/groups');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        groupsCache = await res.json();
    } catch (err) {
        console.error('Ошибка загрузки групп:', err);
    }
    return groupsCache;
}

// ─── Summary-бар ────────────────────────────────────────────

function updateSummaryBar(items) {
    const counts = { green: 0, yellow: 0, red: 0 };
    items.forEach(c => {
        const s = c.status || 'unknown';
        if (counts[s] !== undefined) counts[s]++;
    });

    document.getElementById('summary-red-count').textContent = counts.red;
    document.getElementById('summary-yellow-count').textContent = counts.yellow;
    document.getElementById('summary-green-count').textContent = counts.green;

    const bar = document.getElementById('summary-bar');
    bar.classList.toggle('hidden', items.length === 0);

    // Подсветка активного фильтра
    document.querySelectorAll('.summary-chip[data-filter]').forEach(btn => {
        btn.classList.toggle('active-filter', btn.dataset.filter === statusFilter);
    });
    document.getElementById('summary-reset').classList.toggle('hidden', statusFilter === null);
}

document.querySelectorAll('.summary-chip[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
        const f = btn.dataset.filter;
        statusFilter = (statusFilter === f) ? null : f;
        currentPage = 1;
        renderedPage = 0;
        loadChickens();
    });
});

document.getElementById('summary-reset').addEventListener('click', () => {
    statusFilter = null;
    currentPage = 1;
    renderedPage = 0;
    loadChickens();
});

// ─── Индикатор обновления и потери связи ────────────────────

function markUpdated() {
    consecutiveErrors = 0;
    document.getElementById('connection-banner').classList.add('hidden');
    const el = document.getElementById('last-updated');
    const now = new Date();
    el.textContent = 'Обновлено: ' + now.toLocaleTimeString('ru-RU', {
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

function markFetchError() {
    consecutiveErrors++;
    if (consecutiveErrors >= 3) {
        document.getElementById('connection-banner').classList.remove('hidden');
    }
}

// ─── Создание ячейки курицы ─────────────────────────────────

function createChickenCell(chicken) {
    const cell = document.createElement('div');
    cell.id = `cell-${chicken.chicken_id}`;
    cell.dataset.chickenId = chicken.chicken_id;

    cell.innerHTML = `
        <input type="checkbox" class="cell-checkbox hidden" data-id="${escapeHtml(String(chicken.chicken_id))}">
        <div class="cell-id">Курица #${escapeHtml(String(chicken.chicken_id))}</div>
        <div class="cell-temp">—<span class="unit"> °C</span></div>
        <div class="cell-voltage" title="— V">— V</div>
        <div class="cell-badge">—</div>
        <div class="cell-group"></div>
    `;

    cell.addEventListener('click', (e) => {
        if (suppressClickChickenId === String(chicken.chicken_id)) {
            suppressClickChickenId = null;
            e.preventDefault();
            return;
        }

        if (selectMode) {
            e.preventDefault();
            toggleSelectChicken(chicken.chicken_id, cell);
        } else {
            openModal(chicken.chicken_id);
        }
    });
    return cell;
}

// ─── Загрузка и отрисовка сетки ──────────────────────────────

async function loadChickens(options = {}) {
    const { preserveScroll = false } = options;

    // В режиме выбора не перерисовываем — только обновляем данные в существующих ячейках
    if (selectMode) {
        try {
            const res = await fetch(`/api/chickens?all=true`);
            if (!res.ok) { markFetchError(); return; }
            const data = await res.json();
            markUpdated();
            allChickensCache = data.items;
            updateSummaryBar(data.items);
            data.items.forEach(c => {
                const cell = document.getElementById(`cell-${c.chicken_id}`);
                if (cell) updateCell(cell, c);
            });
        } catch (_) { markFetchError(); }
        return;
    }

    if (viewMode === 'groups') {
        await loadChickensGrouped({ preserveScroll });
        return;
    }

    if (groupsCache.length === 0) await loadGroups();

    // Сначала загрузим все для summary и кэша навигации
    let allData;
    try {
        const res = await fetch(`/api/chickens?all=true`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        allData = await res.json();
        markUpdated();
    } catch (err) {
        console.error('Ошибка загрузки куриц:', err);
        markFetchError();
        return;
    }

    allChickensCache = allData.items;
    updateSummaryBar(allData.items);

    // Фильтрация и сортировка
    let items = allData.items.slice();
    if (statusFilter) {
        items = items.filter(c => c.status === statusFilter);
    }
    items.sort((a, b) => (STATUS_PRIORITY[a.status] ?? 3) - (STATUS_PRIORITY[b.status] ?? 3));

    const grid     = document.getElementById('grid');
    const emptyMsg = document.getElementById('empty-msg');

    // Пагинация вручную
    const total = items.length;
    totalPages = Math.ceil(total / perPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * perPage;
    const pageItems = items.slice(start, start + perPage);

    emptyMsg.style.display = total === 0 ? 'block' : 'none';

    // При смене страницы/фильтра очищаем сетку
    if (currentPage !== renderedPage) {
        grid.innerHTML = '';
        renderedPage = currentPage;
    }

    pageItems.forEach(c => {
        let cell = document.getElementById(`cell-${c.chicken_id}`);

        if (!cell) {
            cell = createChickenCell(c);
            grid.appendChild(cell);
        }

        updateCell(cell, c);
    });

    applyGridColumns(grid, pageItems.length, true);

    // Удаляем ячейки, которых нет на текущей странице
    const validIds = new Set(pageItems.map(c => `cell-${c.chicken_id}`));
    Array.from(grid.querySelectorAll('.cell')).forEach(cell => {
        if (!validIds.has(cell.id)) cell.remove();
    });

    document.getElementById('pagination').classList.toggle('hidden', false);
    renderPagination(total);
}

// ─── Загрузка по группам ────────────────────────────────────

async function loadChickensGrouped(options = {}) {
    const { preserveScroll = false } = options;
    const groups = await loadGroups();

    let allData;
    try {
        const res = await fetch('/api/chickens?all=true');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        allData = await res.json();
        markUpdated();
    } catch (err) {
        console.error('Ошибка загрузки куриц:', err);
        markFetchError();
        return;
    }

    allChickensCache = allData.items;
    updateSummaryBar(allData.items);

    const grid     = document.getElementById('grid');
    const emptyMsg = document.getElementById('empty-msg');
    const main     = document.querySelector('main');
    const previousScrollTop = preserveScroll && main ? main.scrollTop : null;

    emptyMsg.style.display = allData.total === 0 ? 'block' : 'none';
    document.getElementById('pagination').classList.add('hidden');

    grid.innerHTML = '';
    grid.classList.add('grouped');

    // Фильтрация
    let items = allData.items;
    if (statusFilter) {
        items = items.filter(c => c.status === statusFilter);
    }

    // Группируем куриц
    const grouped = {};
    const ungrouped = [];

    items.forEach(c => {
        if (c.group_id != null) {
            if (!grouped[c.group_id]) grouped[c.group_id] = [];
            grouped[c.group_id].push(c);
        } else {
            ungrouped.push(c);
        }
    });

    // Сортируем внутри каждой группы по статусу
    const sortByStatus = arr => arr.sort((a, b) =>
        (STATUS_PRIORITY[a.status] ?? 3) - (STATUS_PRIORITY[b.status] ?? 3));

    // Отрисовка секций для каждой группы
    groups.forEach(g => {
        const chickens = sortByStatus(grouped[g.id] || []);
        // Считаем статусы для заголовка
        const dangerCount = chickens.filter(c => c.status === 'red').length;
        const warnCount = chickens.filter(c => c.status === 'yellow').length;
        const section = createGroupSection(g.name, chickens, `group-${g.id}`, dangerCount, warnCount);
        grid.appendChild(section);
        applyGroupGridColumns(section.querySelector('.group-grid'), chickens.length);
    });

    // Секция "Без загона"
    if (ungrouped.length > 0) {
        const sortedUngrouped = sortByStatus(ungrouped);
        const dangerCount = sortedUngrouped.filter(c => c.status === 'red').length;
        const warnCount = sortedUngrouped.filter(c => c.status === 'yellow').length;
        const section = createGroupSection('Без загона', sortedUngrouped, 'ungrouped', dangerCount, warnCount);
        section.classList.add('ungrouped');
        grid.appendChild(section);
        applyGroupGridColumns(section.querySelector('.group-grid'), ungrouped.length);
    }

    if (previousScrollTop != null) {
        restoreMainScroll(previousScrollTop);
    }
}

function restoreMainScroll(scrollTop) {
    const main = document.querySelector('main');
    if (!main) return;

    const restore = () => {
        const maxScrollTop = Math.max(0, main.scrollHeight - main.clientHeight);
        main.scrollTop = Math.min(scrollTop, maxScrollTop);
    };

    restore();
    requestAnimationFrame(restore);
}

function createGroupSection(name, chickens, groupId, dangerCount, warnCount) {
    const section = document.createElement('div');
    const sectionStatus = dangerCount > 0 ? 'red' : warnCount > 0 ? 'yellow' : chickens.length > 0 ? 'green' : 'empty';
    section.className = `group-section ${sectionStatus}`;
    section.dataset.groupId = groupId;

    // Восстанавливаем свёрнутое состояние
    if (collapsedGroups.has(groupId)) {
        section.classList.add('collapsed');
    }

    // Статус в заголовке загона
    let statusHint = '';
    if (dangerCount > 0) {
        statusHint = `<span class="group-status-hint red">${dangerCount} в опасности</span>`;
    } else if (warnCount > 0) {
        statusHint = `<span class="group-status-hint yellow">${warnCount} предупр.</span>`;
    }

    const header = document.createElement('div');
    header.className = 'group-section-header';
    header.innerHTML = `
        <span class="toggle-arrow">\u25BC</span>
        ${selectMode ? `<input type="checkbox" class="group-select-all" data-group-id="${groupId}" title="Выбрать весь загон">` : ''}
        <span class="group-name">${escapeHtml(name)}</span>
        ${statusHint}
        <span class="group-count">${chickens.length} шт</span>
    `;
    header.addEventListener('click', (e) => {
        if (e.target.classList.contains('group-select-all')) return;
        section.classList.toggle('collapsed');
        if (section.classList.contains('collapsed')) {
            collapsedGroups.add(groupId);
        } else {
            collapsedGroups.delete(groupId);
        }
    });

    // Обработчик «Выбрать весь загон»
    const selectAllCb = header.querySelector('.group-select-all');
    if (selectAllCb) {
        selectAllCb.addEventListener('change', () => {
            const cells = section.querySelectorAll('.cell');
            cells.forEach(cell => {
                const id = cell.dataset.chickenId;
                if (selectAllCb.checked) {
                    if (!selectedChickens.has(id)) toggleSelectChicken(id, cell);
                } else {
                    if (selectedChickens.has(id)) toggleSelectChicken(id, cell);
                }
            });
        });
    }

    section.appendChild(header);

    const sectionGrid = document.createElement('div');
    sectionGrid.className = 'group-grid';
    section.appendChild(sectionGrid);

    chickens.forEach(c => {
        const cell = createChickenCell(c);
        updateCell(cell, c);
        sectionGrid.appendChild(cell);
    });

    return section;
}

// Обновляет данные внутри ячейки
function updateCell(cell, data) {
    const status = data.status || 'unknown';

    // Сохраняем selectable/selected при обновлении
    const wasSelected = cell.classList.contains('selected');
    const wasSelectable = cell.classList.contains('selectable');
    cell.className = `cell ${status}`;
    if (wasSelected) cell.classList.add('selected');
    if (wasSelectable) cell.classList.add('selectable');

    cell.querySelector('.cell-temp').innerHTML =
        data.temperature != null
            ? `${data.temperature.toFixed(1)}<span class="unit"> °C</span>`
            : `—<span class="unit"> °C</span>`;

    // Батарея — иконка вместо числа
    const voltEl = cell.querySelector('.cell-voltage');
    const bat = getBatteryLevel(data.voltage);
    if (bat) {
        voltEl.innerHTML = `<span class="bat-icon ${bat.cls}">${bat.icon}</span>`;
        voltEl.title = `${bat.label} (${data.voltage.toFixed(2)} V)`;
    } else {
        voltEl.innerHTML = '—';
        voltEl.title = '— V';
    }

    cell.querySelector('.cell-badge').textContent =
        STATUS_LABELS[status] || '—';

    // Показываем загон на карточке
    const groupTag = cell.querySelector('.cell-group');
    if (groupTag) {
        const group = groupsCache.find(g => g.id === data.group_id);
        groupTag.textContent = group ? group.name : '';
        groupTag.style.display = group ? 'inline-block' : 'none';
    }
}

// ─── Пагинация ───────────────────────────────────────────────

function renderPagination(total) {
    totalPages = Math.ceil(total / perPage) || 1;

    const paginationEl = document.getElementById('pagination');
    const pageInfoEl   = document.getElementById('page-info');
    const btnPrev      = document.getElementById('btn-prev');
    const btnNext      = document.getElementById('btn-next');

    paginationEl.classList.toggle('hidden', totalPages <= 1);

    pageInfoEl.textContent = `Страница ${currentPage} из ${totalPages}`;

    btnPrev.disabled = currentPage <= 1;
    btnNext.disabled = currentPage >= totalPages;
}

function setPageSize(size) {
    perPage = normalizePageSize(size);
    localStorage.setItem('chicken-page-size', String(perPage));
    document.querySelectorAll('.page-size-btn').forEach(btn => {
        const active = Number(btn.dataset.size) === perPage;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

document.querySelectorAll('.page-size-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        const size = normalizePageSize(btn.dataset.size);
        if (size === perPage) return;
        setPageSize(size);
        currentPage = 1;
        renderedPage = 0;
        await loadChickens();
    });
});

document.getElementById('btn-prev').addEventListener('click', async () => {
    if (currentPage > 1) {
        currentPage--;
        await loadChickens();
    }
});

document.getElementById('btn-next').addEventListener('click', async () => {
    if (currentPage < totalPages) {
        currentPage++;
        await loadChickens();
    }
});

// ─── Переключение вида ──────────────────────────────────────

document.getElementById('btn-view-all').addEventListener('click', () => {
    if (viewMode === 'all') return;
    viewMode = 'all';
    document.getElementById('btn-view-all').classList.add('active');
    document.getElementById('btn-view-groups').classList.remove('active');
    currentPage = 1;
    renderedPage = 0;
    const grid = document.getElementById('grid');
    grid.innerHTML = '';
    grid.classList.remove('grouped');
    loadChickens();
});

document.getElementById('btn-view-groups').addEventListener('click', () => {
    if (viewMode === 'groups') return;
    viewMode = 'groups';
    document.getElementById('btn-view-groups').classList.add('active');
    document.getElementById('btn-view-all').classList.remove('active');
    document.getElementById('grid').innerHTML = '';
    loadChickens();
});

// ─── Модальное окно с графиком ───────────────────────────────

function formatChartAxisLabel(timestamp, hours) {
    const date = new Date(timestamp);
    if (hours < 24) {
        return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    if (hours <= 168) {
        return date.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        });
    }
    if (hours <= 720) {
        return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    }
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
}

function getChartDisplayOptions(pointCount, hours) {
    if (hours >= 720) {
        return { maxTicksLimit: 8, pointRadius: 0, pointHoverRadius: 5, tension: 0.3 };
    }
    if (hours >= 168) {
        return { maxTicksLimit: 8, pointRadius: 0, pointHoverRadius: 5, tension: 0.28 };
    }
    if (hours >= 24) {
        return { maxTicksLimit: 9, pointRadius: pointCount > 80 ? 0 : 2, pointHoverRadius: 6, tension: 0.25 };
    }
    return { maxTicksLimit: 7, pointRadius: pointCount > 1000 ? 0 : pointCount > 300 ? 1 : 3, pointHoverRadius: 6, tension: 0.2 };
}

async function openModal(chickenId) {
    selectedChicken = chickenId;
    selectedHours   = 1;

    document.getElementById('modal-title').textContent = `Курица #${String(chickenId)}`;
    document.getElementById('modal').classList.remove('hidden');

    // Обновляем кнопки навигации
    updateModalNav();

    // Сбрасываем активную кнопку времени на "1 час"
    document.querySelectorAll('.time-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.hours) === 1);
    });

    // Заполняем dropdown групп
    await loadGroups();
    const select = document.getElementById('modal-group-select');
    select.innerHTML = '<option value="">Без загона</option>';
    groupsCache.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        select.appendChild(opt);
    });

    // Определяем текущую группу курицы
    try {
        const res = await fetch(`/api/chickens/${encodeURIComponent(chickenId)}`);
        if (res.ok) {
            const chicken = await res.json();
            select.value = chicken.group_id != null ? chicken.group_id : '';
        }
    } catch (_) {}

    await loadChart(chickenId, selectedHours);
}

// Навигация между курицами в модалке
function updateModalNav() {
    const ids = allChickensCache.map(c => c.chicken_id);
    const idx = ids.indexOf(selectedChicken);
    document.getElementById('modal-prev').disabled = idx <= 0;
    document.getElementById('modal-next').disabled = idx < 0 || idx >= ids.length - 1;
}

document.getElementById('modal-prev').addEventListener('click', () => {
    const ids = allChickensCache.map(c => c.chicken_id);
    const idx = ids.indexOf(selectedChicken);
    if (idx > 0) openModal(ids[idx - 1]);
});

document.getElementById('modal-next').addEventListener('click', () => {
    const ids = allChickensCache.map(c => c.chicken_id);
    const idx = ids.indexOf(selectedChicken);
    if (idx >= 0 && idx < ids.length - 1) openModal(ids[idx + 1]);
});

// Обработчик смены группы в модалке
document.getElementById('modal-group-select').addEventListener('change', async (e) => {
    if (!selectedChicken) return;
    const groupId = e.target.value === '' ? null : parseInt(e.target.value);
    try {
        await fetch(`/api/chickens/${encodeURIComponent(selectedChicken)}/group`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ group_id: groupId })
        });
        // Обновить сетку
        await loadChickens();
    } catch (err) {
        console.error('Ошибка назначения группы:', err);
    }
});

// Обработчик удаления курицы
document.getElementById('btn-delete-chicken').addEventListener('click', async () => {
    if (!selectedChicken) return;
    if (!confirm(`Удалить курицу #${selectedChicken}? Все данные температуры будут удалены.`)) return;
    try {
        const res = await fetch(`/api/chickens/${encodeURIComponent(selectedChicken)}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            closeModal();
            await loadChickens();
        } else {
            alert('Ошибка удаления курицы');
        }
    } catch (err) {
        console.error('Ошибка удаления курицы:', err);
        alert('Ошибка удаления курицы');
    }
});

// Загружает историю и строит график
async function loadChart(chickenId, hours) {
    let history;
    try {
        const res = await fetch(`/api/chickens/${encodeURIComponent(chickenId)}/history?hours=${hours}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        history = await res.json();
    } catch (err) {
        console.error('Ошибка загрузки истории:', err);
        document.getElementById('modal-info').textContent = 'Ошибка загрузки данных';
        return;
    }

    // Подписи оси X — время в формате ЧЧ:ММ
    // Полные метки для тултипов (дата + время с секундами)
    const fullLabels = history.map(r => {
        const d = new Date(r.timestamp);
        return d.toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    });

    // Короткие метки для оси X
    const labels = history.map(r => formatChartAxisLabel(r.timestamp, hours));

    const temps = history.map(r => r.temperature);
    const voltages = history.map(r => r.voltage);
    const displayOptions = getChartDisplayOptions(history.length, hours);
    const tempMinValue = temps.length ? Math.min(...temps) : 40;
    const tempMaxValue = temps.length ? Math.max(...temps) : 42;
    const yPadding = hours >= 720 ? 0.35 : hours >= 168 ? 0.25 : 0.18;
    const yMin = Math.floor((tempMinValue - yPadding) * 10) / 10;
    const yMax = Math.ceil((tempMaxValue + yPadding) * 10) / 10;

    // Удаляем старый график перед созданием нового
    if (chartInstance) chartInstance.destroy();

    // Обновляем информационную строку под заголовком
    const infoEl = document.getElementById('modal-info');
    if (history.length === 0) {
        infoEl.textContent = 'Нет данных за выбранный период';
    } else {
        const min = tempMinValue.toFixed(1);
        const max = tempMaxValue.toFixed(1);
        const avg = (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(1);
        infoEl.textContent = `Точек: ${history.length}  •  Мин: ${min}°C  •  Макс: ${max}°C  •  Среднее: ${avg}°C`;
    }

    const ctx = document.getElementById('tempChart').getContext('2d');

    chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label: 'Температура (°C)',
                data: temps,
                borderColor: '#e94560',
                backgroundColor: 'rgba(233, 69, 96, 0.08)',
                fill: true,
                tension: displayOptions.tension,
                pointRadius: displayOptions.pointRadius,
                pointHoverRadius: displayOptions.pointHoverRadius,
                pointBackgroundColor: '#e94560',
                pointBorderColor: '#fff',
                pointBorderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'nearest',
                intersect: false
            },
            plugins: {
                legend: { labels: { color: '#aaa', font: { size: 12 } } },
                tooltip: {
                    backgroundColor: 'rgba(20, 20, 50, 0.95)',
                    titleColor: '#fff',
                    bodyColor: '#ddd',
                    borderColor: '#e94560',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        title: function(items) {
                            return fullLabels[items[0].dataIndex];
                        },
                        label: function(item) {
                            const lines = [`Температура: ${item.raw.toFixed(2)} °C`];
                            const v = voltages[item.dataIndex];
                            if (v != null) lines.push(`Напряжение: ${v.toFixed(2)} V`);
                            return lines;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: {
                        color: '#666',
                        maxTicksLimit: displayOptions.maxTicksLimit,
                        autoSkip: true,
                        maxRotation: 0,
                        minRotation: 0,
                    },
                    grid:  { color: '#1e1e3a' }
                },
                y: {
                    min: yMin,
                    max: yMax,
                    ticks: { color: '#666' },
                    grid:  { color: '#1e1e3a' }
                }
            }
        }
    });
}

// ─── Кнопки выбора периода ───────────────────────────────────

document.querySelectorAll('.time-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
        selectedHours = parseInt(btn.dataset.hours);

        document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        if (selectedChicken) await loadChart(selectedChicken, selectedHours);
    });
});

// ─── Закрытие модалки ────────────────────────────────────────

function closeModal() {
    document.getElementById('modal').classList.add('hidden');
    if (chartInstance) {
        chartInstance.destroy();
        chartInstance = null;
    }
}

document.getElementById('modal-close').addEventListener('click', closeModal);

// Клик на тёмный фон закрывает модалку
document.getElementById('modal').addEventListener('click', e => {
    if (e.target === document.getElementById('modal')) closeModal();
});

// ─── Управление загонами — модалка ───────────────────────────

function openGroupsModal() {
    document.getElementById('groups-modal').classList.remove('hidden');
    renderGroupsList();
}

function closeGroupsModal() {
    document.getElementById('groups-modal').classList.add('hidden');
}

document.getElementById('btn-manage-groups').addEventListener('click', openGroupsModal);
document.getElementById('groups-modal-close').addEventListener('click', closeGroupsModal);
document.getElementById('groups-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('groups-modal')) closeGroupsModal();
});

async function renderGroupsList() {
    await loadGroups();
    const list = document.getElementById('groups-list');

    if (groupsCache.length === 0) {
        list.innerHTML = '<div class="groups-empty">Нет загонов. Создайте первый!</div>';
        return;
    }

    list.innerHTML = '';
    groupsCache.forEach(g => {
        const item = document.createElement('div');
        item.className = 'group-item';
        item.innerHTML = `
            <span class="group-item-name">${escapeHtml(g.name)}</span>
            <div class="group-item-actions">
                <button class="btn-rename" data-id="${g.id}">Переименовать</button>
                <button class="btn-delete" data-id="${g.id}">Удалить</button>
            </div>
        `;

        item.querySelector('.btn-rename').addEventListener('click', async () => {
            const newName = prompt('Новое название загона:', g.name);
            if (newName && newName.trim()) {
                try {
                    await fetch(`/api/groups/${g.id}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: newName.trim() })
                    });
                    await renderGroupsList();
                    await loadChickens();
                } catch (err) {
                    console.error('Ошибка переименования:', err);
                }
            }
        });

        item.querySelector('.btn-delete').addEventListener('click', async () => {
            if (!confirm(`Удалить загон "${g.name}"? Курицы станут "без загона".`)) return;
            try {
                await fetch(`/api/groups/${g.id}`, { method: 'DELETE' });
                await renderGroupsList();
                await loadChickens();
            } catch (err) {
                console.error('Ошибка удаления:', err);
            }
        });

        list.appendChild(item);
    });
}

// Создание группы
document.getElementById('btn-create-group').addEventListener('click', async () => {
    const input = document.getElementById('new-group-name');
    const name = input.value.trim();
    if (!name) return;

    try {
        const res = await fetch('/api/groups', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (res.ok) {
            input.value = '';
            await renderGroupsList();
            await loadChickens();
        }
    } catch (err) {
        console.error('Ошибка создания группы:', err);
    }
});

// Enter в поле ввода создаёт группу
document.getElementById('new-group-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-create-group').click();
});

// ─── Утилиты ─────────────────────────────────────────────────

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ─── Модалка порогов температуры ─────────────────────────────

const DEFAULTS = { temp_green_min: 40, temp_green_max: 42, temp_yellow_max: 43 };

function updateThresholdsPreview() {
    const gmin = parseFloat(document.getElementById('inp-green-min').value);
    const gmax = parseFloat(document.getElementById('inp-green-max').value);
    const ymax = parseFloat(document.getElementById('inp-yellow-max').value);
    const errEl = document.getElementById('thresholds-error');

    if (isNaN(gmin) || isNaN(gmax) || isNaN(ymax)) {
        errEl.classList.add('hidden');
        return;
    }

    if (gmin >= gmax || gmax >= ymax) {
        errEl.textContent = 'Значения должны идти по возрастанию: Норма от < Норма до < Предупреждение до';
        errEl.classList.remove('hidden');
        document.getElementById('btn-save-thresholds').disabled = true;
    } else {
        errEl.classList.add('hidden');
        document.getElementById('btn-save-thresholds').disabled = false;
    }

    // Обновляем ширины зон превью (приблизительно)
    const range = (ymax + 2) - (gmin - 2);
    const preview = document.getElementById('thresholds-preview');
    const zones = preview.querySelectorAll('.tp-zone');
    const redLowW  = ((gmin - (gmin - 2)) / range * 100);
    const greenW   = ((gmax - gmin) / range * 100);
    const yellowW  = ((ymax - gmax) / range * 100);
    const redHighW = (2 / range * 100);
    zones[0].style.flex = redLowW;
    zones[1].style.flex = greenW;
    zones[2].style.flex = yellowW;
    zones[3].style.flex = redHighW;

    zones[0].title = `< ${gmin}°C`;
    zones[1].title = `${gmin}–${gmax}°C`;
    zones[2].title = `${gmax}–${ymax}°C`;
    zones[3].title = `> ${ymax}°C`;
}

// Слушаем изменения полей порогов
['inp-green-min', 'inp-green-max', 'inp-yellow-max'].forEach(id => {
    document.getElementById(id).addEventListener('input', updateThresholdsPreview);
});

function openThresholdsModal() {
    fetch('/api/settings')
        .then(r => r.json())
        .then(s => {
            document.getElementById('inp-green-min').value = s.temp_green_min;
            document.getElementById('inp-green-max').value = s.temp_green_max;
            document.getElementById('inp-yellow-max').value = s.temp_yellow_max;
            document.getElementById('thresholds-modal').classList.remove('hidden');
            document.getElementById('thresholds-error').classList.add('hidden');
            document.getElementById('btn-save-thresholds').disabled = false;
            updateThresholdsPreview();
        });
}

function closeThresholdsModal() {
    document.getElementById('thresholds-modal').classList.add('hidden');
}

document.getElementById('btn-edit-thresholds').addEventListener('click', openThresholdsModal);
document.getElementById('thresholds-modal-close').addEventListener('click', closeThresholdsModal);
document.getElementById('thresholds-modal').addEventListener('click', e => {
    if (e.target === document.getElementById('thresholds-modal')) closeThresholdsModal();
});

document.getElementById('btn-save-thresholds').addEventListener('click', async () => {
    const greenMin = parseFloat(document.getElementById('inp-green-min').value);
    const greenMax = parseFloat(document.getElementById('inp-green-max').value);
    const yellowMax = parseFloat(document.getElementById('inp-yellow-max').value);

    if (isNaN(greenMin) || isNaN(greenMax) || isNaN(yellowMax)) return;
    if (greenMin >= greenMax || greenMax >= yellowMax) return;

    try {
        const res = await fetch('/api/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                temp_green_min: greenMin,
                temp_green_max: greenMax,
                temp_yellow_max: yellowMax
            })
        });
        if (res.ok) {
            closeThresholdsModal();
            await loadSettings();
            await loadChickens();
        }
    } catch (err) {
        console.error('Ошибка сохранения порогов:', err);
    }
});

document.getElementById('btn-reset-thresholds').addEventListener('click', () => {
    document.getElementById('inp-green-min').value = DEFAULTS.temp_green_min;
    document.getElementById('inp-green-max').value = DEFAULTS.temp_green_max;
    document.getElementById('inp-yellow-max').value = DEFAULTS.temp_yellow_max;
    updateThresholdsPreview();
});

// ─── Клавиша Escape закрывает любую модалку ─────────────────

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        closeModal();
        closeGroupsModal();
        closeThresholdsModal();
    }
});

// ─── Множественный выбор ────────────────────────────────────

function enterSelectMode() {
    selectMode = true;
    selectedChickens.clear();
    document.getElementById('bulk-bar').classList.remove('hidden');
    document.getElementById('btn-select-mode').textContent = 'Отменить выбор';
    document.getElementById('btn-select-mode').classList.add('active-select');
    document.querySelectorAll('.cell-checkbox').forEach(cb => cb.classList.remove('hidden'));
    document.querySelectorAll('.cell').forEach(c => c.classList.add('selectable'));
    updateBulkBar();
    loadBulkGroups();

    // Если в режиме загонов — перерисовать для показа чекбоксов групп
    if (viewMode === 'groups') {
        renderedPage = 0;
        loadChickens();
    }
}

function exitSelectMode() {
    selectMode = false;
    selectedChickens.clear();
    document.getElementById('bulk-bar').classList.add('hidden');
    document.getElementById('btn-select-mode').textContent = 'Выбрать';
    document.getElementById('btn-select-mode').classList.remove('active-select');
    document.querySelectorAll('.cell-checkbox').forEach(cb => {
        cb.classList.add('hidden');
        cb.checked = false;
    });
    document.querySelectorAll('.cell.selected').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.cell.selectable').forEach(c => c.classList.remove('selectable'));
}

function toggleSelectChicken(chickenId, cell) {
    const cb = cell.querySelector('.cell-checkbox');
    if (selectedChickens.has(chickenId)) {
        selectedChickens.delete(chickenId);
        cell.classList.remove('selected');
        if (cb) cb.checked = false;
    } else {
        selectedChickens.add(chickenId);
        cell.classList.add('selected');
        if (cb) cb.checked = true;
    }
    updateBulkBar();
}

function updateBulkBar() {
    document.getElementById('bulk-count').textContent = `Выбрано: ${selectedChickens.size}`;
    document.getElementById('btn-bulk-assign').disabled = selectedChickens.size === 0;
}

async function loadBulkGroups() {
    await loadGroups();
    const select = document.getElementById('bulk-group-select');
    select.innerHTML = '<option value="">Без загона</option>';
    groupsCache.forEach(g => {
        const opt = document.createElement('option');
        opt.value = g.id;
        opt.textContent = g.name;
        select.appendChild(opt);
    });
}

// Длинное нажатие (500мс) активирует режим выбора
let longPressTimer = null;
document.getElementById('grid').addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.cell');
    if (!cell || selectMode) return;
    longPressTimer = setTimeout(() => {
        enterSelectMode();
        const id = cell.dataset.chickenId;
        if (id) {
            suppressClickChickenId = String(id);
            toggleSelectChicken(id, cell);
        }
    }, LONG_PRESS_MS);
});
document.getElementById('grid').addEventListener('pointerup', () => clearTimeout(longPressTimer));
document.getElementById('grid').addEventListener('pointerleave', () => clearTimeout(longPressTimer));

document.getElementById('btn-bulk-assign').addEventListener('click', async () => {
    if (selectedChickens.size === 0) return;
    const val = document.getElementById('bulk-group-select').value;
    const groupId = val === '' ? null : parseInt(val);
    try {
        await fetch('/api/chickens/bulk-group', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chicken_ids: [...selectedChickens], group_id: groupId })
        });
        exitSelectMode();
        await loadChickens();
    } catch (err) {
        console.error('Ошибка массового назначения:', err);
    }
});

document.getElementById('btn-bulk-cancel').addEventListener('click', exitSelectMode);

document.getElementById('btn-select-mode').addEventListener('click', () => {
    if (selectMode) {
        exitSelectMode();
    } else {
        enterSelectMode();
    }
});

let resizeTimer = null;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        relayoutVisibleGrid();
    }, 180);
});

// ─── QoS-панель ─────────────────────────────────────────────

let qosPanelVisible = false;
let qosChartInstance = null;

document.getElementById('btn-toggle-qos').addEventListener('click', () => {
    qosPanelVisible = !qosPanelVisible;
    document.getElementById('qos-panel').classList.toggle('hidden', !qosPanelVisible);
    document.getElementById('btn-toggle-qos').classList.toggle('active', qosPanelVisible);
    if (qosPanelVisible) loadQosData();
});

// QoS цветовые индикаторы
function qosColor(metric, value) {
    if (value == null) return '';
    if (metric === 'latency') {
        if (value < LATENCY_GOOD_MS) return 'qos-good';
        if (value < LATENCY_WARN_MS) return 'qos-warn';
        return 'qos-bad';
    }
    if (metric === 'loss') {
        if (value < LOSS_GOOD) return 'qos-good';
        if (value < LOSS_WARN) return 'qos-warn';
        return 'qos-bad';
    }
    return '';
}

function qosLabel(metric, value) {
    if (value == null) return '';
    if (metric === 'latency') {
        if (value < LATENCY_GOOD_MS) return 'Отлично';
        if (value < LATENCY_WARN_MS) return 'Приемлемо';
        return 'Критично';
    }
    if (metric === 'loss') {
        if (value < LOSS_GOOD) return 'Отлично';
        if (value < LOSS_WARN) return 'Внимание';
        return 'Критично';
    }
    return '';
}

async function loadQosData() {
    try {
        const res = await fetch('/api/qos/summary?hours=1');
        if (!res.ok) return;
        const s = await res.json();

        const avgEl = document.getElementById('qos-avg-latency');
        const p95El = document.getElementById('qos-p95-latency');
        const lossEl = document.getElementById('qos-loss-rate');

        avgEl.textContent = s.avg_latency_ms != null ? s.avg_latency_ms.toFixed(1) + ' мс' : '— мс';
        p95El.textContent = s.p95_latency_ms != null ? s.p95_latency_ms.toFixed(1) + ' мс' : '— мс';
        lossEl.textContent = s.packet_loss_rate != null ? (s.packet_loss_rate * 100).toFixed(2) + ' %' : '— %';

        // Цветовые индикаторы
        avgEl.className = 'qos-stat-value ' + qosColor('latency', s.avg_latency_ms);
        p95El.className = 'qos-stat-value ' + qosColor('latency', s.p95_latency_ms);
        lossEl.className = 'qos-stat-value ' + qosColor('loss', s.packet_loss_rate);

        // Подписи-оценки
        avgEl.title = qosLabel('latency', s.avg_latency_ms);
        p95El.title = qosLabel('latency', s.p95_latency_ms);
        lossEl.title = qosLabel('loss', s.packet_loss_rate);

        document.getElementById('qos-level').textContent = s.qos_level;
        document.getElementById('qos-total-msg').textContent = s.total_messages;
    } catch (e) {
        console.error('QoS summary error:', e);
    }

    try {
        const res = await fetch('/api/qos/history?hours=1');
        if (!res.ok) return;
        const history = await res.json();
        renderQosChart(history);
    } catch (e) {
        console.error('QoS history error:', e);
    }
}

function renderQosChart(data) {
    if (qosChartInstance) qosChartInstance.destroy();

    const ctx = document.getElementById('qos-latency-chart').getContext('2d');
    qosChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: data.map(d => {
                const t = new Date(d.timestamp);
                return t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            }),
            datasets: [{
                label: 'Средняя задержка (мс)',
                data: data.map(d => d.avg_latency_ms),
                borderColor: '#4fc3f7',
                backgroundColor: 'rgba(79, 195, 247, 0.08)',
                fill: true,
                tension: 0.4,
                pointRadius: data.length > 100 ? 0 : 3,
                pointHoverRadius: 6,
                pointBackgroundColor: '#4fc3f7',
                pointBorderColor: '#fff',
                pointBorderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: false },
            plugins: {
                legend: { labels: { color: '#aaa', font: { size: 12 } } },
                tooltip: {
                    backgroundColor: 'rgba(20, 20, 50, 0.95)',
                    titleColor: '#fff',
                    bodyColor: '#ddd',
                    borderColor: '#4fc3f7',
                    borderWidth: 1,
                    padding: 10,
                    displayColors: false,
                    callbacks: {
                        label: function(item) {
                            const d = data[item.dataIndex];
                            return [`Задержка: ${item.raw.toFixed(2)} мс`, `Сообщений: ${d.count}`];
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: '#666', maxTicksLimit: 10 }, grid: { color: '#1e1e3a' } },
                y: {
                    ticks: { color: '#666' },
                    grid: { color: '#1e1e3a' },
                    title: { display: true, text: 'мс', color: '#666' }
                }
            }
        }
    });
}

// ─── Запуск ──────────────────────────────────────────────────

setPageSize(perPage);
loadSettings();
loadGroups().then(() => loadChickens());
setInterval(() => {
    if (document.hidden) return;
    loadChickens({ preserveScroll: true });
    if (qosPanelVisible) loadQosData();
}, REFRESH_INTERVAL_MS);
