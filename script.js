'use strict';

(() => {

  const $ = id => document.getElementById(id);

  const config = window.ALETHEIA_CONFIG || {};
  const cloud = Boolean(config.supabaseUrl && config.supabaseKey);

  const STORAGE = 'aletheia-locations-v1';
  const CATALOG = 'aletheia-catalog-v2';

  const GROUPS = 'aletheia_category_groups';
  const CATEGORIES = 'aletheia_categories';
  const LOCATIONS = 'aletheia_locations';

  const NEW = '__new__';
  const bounds = [[0, 0], [8192, 8192]];

  const editor = $('editor');
  const manager = $('categoryManager');

  let db, map, layer, tile;

  let groups = [];
  let categories = [];
  let points = [];

  let active = new Set();
  let expanded = new Set();
  let markers = new Map();

  let ready = false;
  let busy = false;
  let initialized = false;
  let placing = false;
  let moving = null;
  let draft = null;

  let toastTimer;
  let refreshTimer;
  let revision = 0;
  let previewVersion = 0;

  // ========================================
  // TODOS OS ÍCONES DO MAPA
  // ========================================

  const icons = {

    templo: {
      files: ['templo.png'],
      symbol: '♜',
      color: '#dedede',
      label: 'Templo'
    },

    entidade: {
      files: ['entidades.png', 'entidade.png'],
      symbol: '✧',
      color: '#ffffff',
      label: 'Entidade'
    },

    planta: {
      files: ['broto.png', 'planta.png'],
      symbol: '❋',
      color: '#a8d5a2',
      label: 'Planta'
    },

    dungeon: {
      files: ['dg.png', 'dungeon.png'],
      symbol: '⚔',
      color: '#b8e2ff',
      label: 'Dungeon'
    },

    missao: {
      files: ['missoes.png', 'missao.png'],
      symbol: '!',
      color: '#f5db86',
      label: 'Missão'
    },

    minerio: {
      files: ['minério.png', 'minerio.png'],
      symbol: '◆',
      color: '#c49770',
      label: 'Minério'
    },

    material: {
      files: ['materiais.png', 'material.png'],
      symbol: '▣',
      color: '#d4e5f3',
      label: 'Material'
    },

    mercador: {
      files: [
        'mercador.png',
        'mercadores.png',
        'Mercador.png'
      ],
      symbol: '♙',
      color: '#f5a9d0',
      label: 'Mercador'
    },

    cristal: {
      files: [
        'cristal.png',
        'Cristal.png',
        'cristais.png',
        'Cristais.png',
        'cristal.PNG',
        'cristal.webp',
        'cristal.jpg',
        'crystal.png',
        'cristal.png.png'
      ],
      symbol: '♦',
      color: '#bda2ff',
      label: 'Cristal'
    },

    outros: {
      files: ['outros.png', 'ilegal.png'],
      symbol: '•',
      color: '#c7b4ea',
      label: 'Outros / Ilegal'
    }

  };

  const imageCache = new Map();

  // Evita carregar versões antigas das imagens.
  const imageVersion = Date.now();

  // ========================================
  // FUNÇÕES AUXILIARES
  // ========================================

  function node(tag, cls, text) {
    const el = document.createElement(tag);

    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;

    return el;
  }

  function button(text, cls, action) {
    const el = node('button', cls, text);

    el.type = 'button';
    el.onclick = action;

    return el;
  }

  function clean(value) {
    return String(value || '')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalize(value) {
    return clean(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function label(value) {
    const result = clean(value);

    if (!result || result.length > 80) {
      throw new Error('Informe um nome de 1 a 80 caracteres.');
    }

    return result;
  }

  function uid(prefix) {
    return prefix + crypto.randomUUID().replace(/-/g, '');
  }

  function clamp(value) {
    return Math.max(0, Math.min(8192, value));
  }

  function safeImage(value) {
    return typeof value === 'string' &&
      /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value);
  }

  function validKind(kind) {
    return Object.prototype.hasOwnProperty.call(icons, kind);
  }

  function status(text, mode = '') {
    $('status').textContent = text;
    $('status').className = 'status ' + mode;
    $('status').title = text;
  }

  function toast(text) {
    $('toast').textContent = text;
    $('toast').hidden = false;

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
      $('toast').hidden = true;
    }, 5000);
  }

  function errorText(error) {

    if (error?.code === '23505') {
      return 'Já existe uma categoria com esse nome.';
    }

    if (error?.code === '23503') {
      return 'Existem categorias ou marcadores vinculados.';
    }

    if (error?.code === '23514') {
      return 'O banco recusou a alteração. Execute o SQL atualizado.';
    }

    return error?.message || 'Não foi possível concluir.';
  }

  function fail(error) {
    console.error(error);
    toast(errorText(error));
  }

  function lock(value) {

    busy = value;

    const controls = document.querySelectorAll(
      '#editor button, #editor input, ' +
      '#editor select, #editor textarea, ' +
      '#categoryManager button, ' +
      '#categoryManager select, ' +
      '#add, #manageCategories'
    );

    controls.forEach(el => {
      el.disabled = value || !ready;
    });

    if (!value && ready) {
      managerControls();
    }
  }

  async function task(action, errorId) {

    if (busy || !ready) return;

    revision++;
    lock(true);

    if (errorId) $(errorId).textContent = '';

    try {

      await action();

    } catch (error) {

      if (errorId) {
        $(errorId).textContent = errorText(error);
      } else {
        fail(error);
      }

    } finally {

      lock(false);

      if (cloud) scheduleRefresh();
    }
  }

  function readStorage(key, fallback) {
    const raw = localStorage.getItem(key);

    return raw === null ? fallback : JSON.parse(raw);
  }

  // ========================================
  // CATEGORIAS INICIAIS
  // ========================================

  function initialCatalog() {

    const original = window.ALETHEIA_CATEGORIES;

    if (!Array.isArray(original)) {
      throw new Error('Não foi possível carregar categories.js.');
    }

    const definitions = [
      ['plantas', 'planta'],
      ['olimpianos', 'templo'],
      ['nao_olimpianos', 'templo'],
      ['entidades', 'entidade'],
      ['missoes', 'missao'],
      ['minerios', 'minerio'],
      ['materiais', 'material'],
      ['dungeons', 'dungeon'],
      ['outros', 'outros']
    ];

    const initialGroups = [];
    const initialCategories = [];

    original.forEach((g, index) => {

      const [id, kind] = definitions[index] ||
        ['grupo_' + index, 'outros'];

      initialGroups.push({
        id,
        label: g.label,
        color: g.color || icons[kind].color,
        icon_kind: kind,
        sort_order: index
      });

      g.items.forEach((item, position) => {

        initialCategories.push({
          id: item[0],
          group_id: id,
          label: item[1],
          symbol: item[2] || icons[kind].symbol,
          sort_order: position
        });

      });
    });

    return {
      groups: initialGroups,
      categories: initialCategories
    };
  }

  function sortCatalog(a, b) {
    return (a.sort_order - b.sort_order) ||
      a.label.localeCompare(b.label, 'pt-BR');
  }

  function getGroup(id) {
    return groups.find(g => g.id === id);
  }

  function getCategory(id) {
    return categories.find(c => c.id === id);
  }

  function items(groupId) {
    return categories.filter(c => c.group_id === groupId);
  }

  function groupOf(categoryId) {
    return getGroup(getCategory(categoryId)?.group_id);
  }

  function categoryLabel(id) {

    const c = getCategory(id);

    if (!c) return 'Sem categoria';

    if (
      ['olimpianos', 'nao_olimpianos'].includes(c.group_id) &&
      id !== 'templo_outro' &&
      !/^templo\b/i.test(c.label)
    ) {
      return 'Templo de ' + c.label;
    }

    return c.label;
  }

  function kindOf(id) {

    const kind = groupOf(id)?.icon_kind;

    return validKind(kind) ? kind : 'outros';
  }

  function colorOf(id) {

    const color = groupOf(id)?.color;

    return /^#[0-9a-f]{6}$/i.test(color || '')
      ? color
      : icons[kindOf(id)].color;
  }

  function applyCatalog(nextGroups, nextCategories) {

    const old = categories;
    const oldActive = new Set(active);
    const oldIds = new Set(old.map(c => c.id));

    const allSelected = old.every(c => oldActive.has(c.id));

    groups = [...nextGroups].sort(sortCatalog);

    categories = [...nextCategories]
      .filter(c => getGroup(c.group_id))
      .sort(sortCatalog);

    active = new Set();

    for (const c of categories) {

      if (oldIds.has(c.id)) {

        if (oldActive.has(c.id)) active.add(c.id);

      } else {

        const groupSelected = old.some(
          x => x.group_id === c.group_id &&
            oldActive.has(x.id)
        );

        if (!initialized || allSelected || groupSelected) {
          active.add(c.id);
        }
      }
    }

    initialized = true;

    expanded = new Set(
      [...expanded].filter(id => getGroup(id))
    );

    if (editor.open) {
      editorOptions(
        $('mainCategory').value,
        $('category').value
      );
    }

    if (manager.open) syncManager();
  }

  // ========================================
  // INICIALIZAÇÃO DO MAPA
  // ========================================

  function initMap() {

    const CRS = L.extend({}, L.CRS.Simple, {
      transformation: new L.Transformation(
        1 / 32, 0, 1 / 32, 0
      )
    });

    map = L.map('map', {
      crs: CRS,
      minZoom: 0,
      maxZoom: 5,
      maxBounds: bounds,
      maxBoundsViscosity: .8,
      zoomControl: true
    });

    changeStyle('satelite');

    layer = L.layerGroup().addTo(map);

    map.fitBounds(bounds);

    map.on('click', event => {

      if (!placing || busy || !ready) return;

      if (!L.latLngBounds(bounds).contains(event.latlng)) {
        toast('Escolha uma posição dentro do mapa.');
        return;
      }

      endPlacement();

      openEditor({
        name: '',
        description: '',
        category: categories[0]?.id || '',
        lat: clamp(event.latlng.lat),
        lng: clamp(event.latlng.lng),
        icon: null,
        photo: null
      });

    });

    $('home').onclick = () => map.fitBounds(bounds);

    $('style').onchange = event => {
      changeStyle(event.target.value);
    };
  }

  function changeStyle(style) {

    if (!['satelite', 'atlas', 'grid'].includes(style)) return;

    if (tile) map.removeLayer(tile);

    tile = L.tileLayer(
      'https://viruxe.github.io/gtav-map-tiles/' +
      style + '/{z}/{x}-{y}.webp',
      {
        minZoom: 0,
        maxZoom: 5,
        noWrap: true,
        bounds,
        attribution:
          'Mapa: <a href="https://github.com/VIRUXE/gtav-map-tiles" target="_blank" rel="noopener">VIRUXE</a> · GTA V / Rockstar Games'
      }
    ).addTo(map);
  }

  function toggleSidebar(close) {

    $('workspace').classList.toggle('collapsed', close);

    $('toggleSidebar').setAttribute(
      'aria-expanded', String(!close)
    );

    requestAnimationFrame(() => map.invalidateSize());
  }

  // ========================================
  // CARREGAMENTO DOS ÍCONES
  // ========================================

  function iconURL(file) {

    const url = new URL(
      'icons/' + encodeURIComponent(file),
      document.baseURI
    );

    url.searchParams.set('v', imageVersion);

    return url.href;
  }

  function imageHasContent(image) {

    try {

      const canvas = document.createElement('canvas');

      canvas.width = 64;
      canvas.height = 64;

      const ctx = canvas.getContext('2d');

      ctx.drawImage(image, 0, 0, 64, 64);

      const pixels = ctx.getImageData(0, 0, 64, 64).data;

      for (let i = 3; i < pixels.length; i += 4) {

        if (pixels[i] > 4) return true;
      }

      return false;

    } catch {

      return true;
    }
  }

  function checkImage(url) {

    if (imageCache.has(url)) {
      return imageCache.get(url);
    }

    const promise = new Promise(resolve => {

      const image = new Image();

      image.onload = () => {
        resolve(
          image.naturalWidth > 0 &&
          image.naturalHeight > 0 &&
          imageHasContent(image)
        );
      };

      image.onerror = () => resolve(false);

      image.src = url;
    });

    imageCache.set(url, promise);

    return promise;
  }

  async function findIconFile(kind) {

    const definition = icons[validKind(kind) ? kind : 'outros'];

    for (const file of definition.files) {

      const url = iconURL(file);

      if (await checkImage(url)) {
        return { url, file };
      }
    }

    return null;
  }

  function fallbackForKind(kind, color) {

    const definition = icons[validKind(kind) ? kind : 'outros'];

    const validColor = /^#[0-9a-f]{6}$/i.test(color || '')
      ? color
      : definition.color;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg"
        width="64" height="64" viewBox="0 0 64 64">

        <circle cx="32" cy="32" r="28"
          fill="#111722" stroke="${validColor}" stroke-width="4"/>

        <text x="32" y="44"
          text-anchor="middle"
          font-size="34"
          font-family="Arial"
          fill="${validColor}">${definition.symbol}</text>

      </svg>
    `;

    return 'data:image/svg+xml;charset=UTF-8,' +
      encodeURIComponent(svg);
  }

  function fallbackIcon(point) {
    return fallbackForKind(
      kindOf(point.category),
      colorOf(point.category)
    );
  }

  async function resolveIcon(point) {

    const kind = kindOf(point.category);

    // Preserva ícones individuais antigos.
    if (safeImage(point.icon)) {

      if (await checkImage(point.icon)) return point.icon;
    }

    // Busca o arquivo da categoria.
    const result = await findIconFile(kind);

    if (result) return result.url;

    // Compatibilidade com imagens antigas.
    if (['missao', 'minerio', 'material'].includes(kind)) {

      const alternative = iconURL('outros.png');

      if (await checkImage(alternative)) return alternative;
    }

    // Caso o arquivo não exista, mantém um marcador visível.
    return fallbackIcon(point);
  }

  function createMapIcon(url) {

    return L.icon({
      iconUrl: url,
      iconSize: [42, 42],
      iconAnchor: [21, 21],
      popupAnchor: [0, -23],
      tooltipAnchor: [0, -23],
      className: 'aletheia-image-marker'
    });
  }

  function prepareMarkerImage(marker, point) {

    const image = marker.getElement();

    if (!image) return;

    image.style.width = '42px';
    image.style.height = '42px';
    image.style.objectFit = 'contain';
    image.style.opacity = '1';
    image.style.visibility = 'visible';
    image.style.display = 'block';
    image.alt = point.name;

    image.onerror = () => {
      image.onerror = null;
      image.src = fallbackIcon(point);
    };
  }

  async function updateMarkerIcon(marker, point) {

    const url = await resolveIcon(point);

    if (markers.get(point.id) !== marker) return;

    marker.setIcon(createMapIcon(url));

    prepareMarkerImage(marker, point);
  }

  // ========================================
  // PRÉVIA DOS ÍCONES NO GERENCIADOR
  // ========================================

  function loadIconOptions() {

    const select = $('groupIcon');

    select.replaceChildren();

    for (const [kind, definition] of Object.entries(icons)) {

      const option = node('option', '', definition.label);

      option.value = kind;

      select.append(option);
    }
  }

  async function updateGroupIconPreview() {

    const version = ++previewVersion;
    const kind = $('groupIcon').value;

    const image = $('groupIconPreview');
    const message = $('groupIconStatus');

    if (!image || !message) return;

    if (!validKind(kind)) {

      image.hidden = true;
      message.textContent = 'Selecione um ícone.';

      return;
    }

    image.src = fallbackForKind(kind);
    image.hidden = false;

    message.textContent = 'Verificando imagem...';
    message.style.color = '#b8e2ff';

    const result = await findIconFile(kind);

    if (version !== previewVersion) return;

    if (result) {

      image.src = result.url;

      message.textContent =
        'Imagem carregada: icons/' + result.file;

      message.style.color = '#a8d5a2';

    } else {

      message.textContent =
        'Imagem não encontrada ou inválida. Confira icons/' +
        icons[kind].files[0];

      message.style.color = '#f1a4a0';
    }
  }

  // ========================================
  // FILTROS E CONTADORES
  // ========================================

  function counter(number) {

    return node(
      'span',
      'category-count' + (number ? '' : ' zero'),
      String(number)
    );
  }

  function renderFilters() {

    $('filters').replaceChildren();

    const counts = new Map();

    points.forEach(p => {
      counts.set(
        p.category,
        (counts.get(p.category) || 0) + 1
      );
    });

    for (const g of groups) {

      const children = items(g.id);

      const wrapper = node('div', 'filter-group');
      const head = node('div', 'filter-group-head');
      const master = node('input');

      master.type = 'checkbox';

      master.setAttribute(
        'aria-label', 'Selecionar ' + g.label
      );

      const selected = children.filter(
        c => active.has(c.id)
      ).length;

      master.checked =
        children.length > 0 &&
        selected === children.length;

      master.indeterminate =
        selected > 0 && selected < children.length;

      master.disabled = children.length === 0;

      master.onchange = () => {

        children.forEach(c => {

          if (master.checked) {
            active.add(c.id);
          } else {
            active.delete(c.id);
          }

        });

        render();
      };

      const opened = expanded.has(g.id);

      const toggle = button('', 'filter-toggle', () => {

        if (expanded.has(g.id)) {
          expanded.delete(g.id);
        } else {
          expanded.add(g.id);
        }

        renderFilters();
      });

      toggle.setAttribute(
        'aria-expanded', String(opened)
      );

      const dot = node('span', 'dot');

      dot.style.background = g.color;

      const total = children.reduce(
        (sum, c) => sum + (counts.get(c.id) || 0),
        0
      );

      toggle.append(
        dot,
        node('span', 'filter-label', g.label),
        counter(total),
        node('span', 'filter-arrow', opened ? '⌄' : '›')
      );

      head.append(master, toggle);
      wrapper.append(head);

      const body = node('div', 'filter-children');

      body.hidden = !opened;

      if (!children.length) {

        body.append(
          node(
            'span',
            'muted small',
            'Nenhuma subcategoria cadastrada.'
          )
        );
      }

      for (const c of children) {

        const row = node('label', 'filter filter-child');
        const checkbox = node('input');

        checkbox.type = 'checkbox';
        checkbox.checked = active.has(c.id);

        checkbox.onchange = () => {

          if (checkbox.checked) {
            active.add(c.id);
          } else {
            active.delete(c.id);
          }

          render();
        };

        row.append(
          checkbox,
          node('span', 'filter-label', c.label),
          counter(counts.get(c.id) || 0)
        );

        body.append(row);
      }

      wrapper.append(body);

      $('filters').append(wrapper);
    }
  }

  // ========================================
  // JANELA DE INFORMAÇÕES
  // ========================================

  function createPopup(point) {

    const box = node('div');

    box.append(
      node('div', 'muted small', categoryLabel(point.category)),
      node('h3', '', point.name)
    );

    if (point.description) {
      box.append(node('p', '', point.description));
    }

    if (safeImage(point.photo)) {

      const image = node('img', 'popup-photo');

      image.src = point.photo;
      image.alt = 'Foto do local';

      box.append(image);
    }

    const actions = node('div', 'popup-actions');

    actions.append(

      button('Editar', 'btn', () => {
        openEditor(point);
      }),

      button('Mover', 'btn', () => {

        if (busy || moving || placing) return;

        const marker = markers.get(point.id);

        if (!marker) return;

        moving = point.id;

        map.closePopup();

        marker.dragging.enable();

        toast('Arraste o marcador. ESC para cancelar.');
      })
    );

    box.append(actions);

    return box;
  }

  // ========================================
  // EXIBIÇÃO DOS MARCADORES
  // ========================================

  function render() {

    if (!layer) return;

    renderFilters();

    if (moving) return;

    layer.clearLayers();
    markers.clear();

    $('locations').replaceChildren();

    const search = normalize($('search').value);

    const visible = points.filter(p =>

      active.has(p.category) &&

      normalize(
        p.name + ' ' +
        (p.description || '') + ' ' +
        categoryLabel(p.category) + ' ' +
        (groupOf(p.category)?.label || '')
      ).includes(search)

    ).sort((a, b) =>
      a.name.localeCompare(b.name, 'pt-BR')
    );

    $('count').textContent =
      visible.length + ' / ' + points.length;

    if (!visible.length) {

      $('locations').append(
        node(
          'div',
          'empty',
          points.length
            ? 'Nenhum local corresponde aos filtros.'
            : 'Nenhum local registrado.'
        )
      );
    }

    for (const p of visible) {

      const marker = L.marker([p.lat, p.lng], {
        icon: createMapIcon(fallbackIcon(p)),
        draggable: false,
        opacity: 1,
        bubblingMouseEvents: false,
        alt: p.name
      }).addTo(layer);

      markers.set(p.id, marker);

      prepareMarkerImage(marker, p);

      updateMarkerIcon(marker, p).catch(console.error);

      marker.bindPopup(() => createPopup(p));

      marker.bindTooltip(
        node('span', '', p.name),
        {
          direction: 'top',
          offset: [0, -4],
          opacity: 1,
          className: 'aletheia-tooltip'
        }
      );

      // MOVER MARCADOR

      marker.on('dragend', async () => {

        const position = marker.getLatLng();

        marker.dragging.disable();

        moving = null;

        await task(async () => {

          const current = points.find(x => x.id === p.id);

          if (!current) {
            throw new Error('O marcador não existe mais.');
          }

          const patch = {
            lat: clamp(position.lat),
            lng: clamp(position.lng)
          };

          const updated = await updateRow(
            LOCATIONS, current, patch
          );

          commitPoints(
            points.map(x => x.id === p.id ? updated : x)
          );

          toast('Posição atualizada.');
        });

        render();
      });

      // LISTA LATERAL

      const item = button('', 'location', () => {

        if (moving) return;

        if (innerWidth <= 700) toggleSidebar(true);

        map.setView(
          [p.lat, p.lng],
          Math.max(map.getZoom(), 3)
        );

        marker.openPopup();
      });

      const image = node('img', 'list-icon');

      image.alt = '';
      image.src = fallbackIcon(p);

      item.append(image);

      resolveIcon(p).then(url => {
        image.src = url;
      }).catch(console.error);

      const content = node('span', 'location-content');
      const categoryText = categoryLabel(p.category);

      content.append(
        node('span', 'location-title', p.name)
      );

      if (normalize(categoryText) !== normalize(p.name)) {

        content.append(
          node('span', 'location-sub', categoryText)
        );
      }

      item.append(
        content,
        node('span', 'muted', '›')
      );

      $('locations').append(item);
    }
  }

  // ========================================
  // ARMAZENAMENTO E SUPABASE
  // ========================================

  function validPoint(p) {

    return p &&
      typeof p.id === 'string' &&
      typeof p.name === 'string' &&
      typeof p.category === 'string' &&
      Number.isFinite(p.lat) &&
      Number.isFinite(p.lng) &&
      p.lat >= 0 && p.lat <= 8192 &&
      p.lng >= 0 && p.lng <= 8192;
  }

  async function fetchRows(table) {

    const rows = [];

    for (let start = 0; ; start += 100) {

      const { data, error } = await db
        .from(table)
        .select('*')
        .order('id')
        .range(start, start + 99);

      if (error) throw error;

      rows.push(...data);

      if (data.length < 100) break;
    }

    return rows;
  }

  async function refresh(force = false) {

    if (!force && (busy || moving)) {
      scheduleRefresh();
      return;
    }

    const version = ++revision;

    let nextGroups;
    let nextCategories;
    let nextPoints;

    if (cloud) {

      [nextGroups, nextCategories, nextPoints] =
        await Promise.all([
          fetchRows(GROUPS),
          fetchRows(CATEGORIES),
          fetchRows(LOCATIONS)
        ]);

    } else {

      const catalog = readStorage(
        CATALOG, initialCatalog()
      );

      nextGroups = catalog.groups;
      nextCategories = catalog.categories;
      nextPoints = readStorage(STORAGE, []);
    }

    if (version !== revision) return;

    if (!force && (busy || moving)) {
      scheduleRefresh();
      return;
    }

    const sortedGroups =
      [...nextGroups].sort(sortCatalog);

    const sortedCategories =
      [...nextCategories].sort(sortCatalog);

    const sortedPoints = nextPoints
      .filter(validPoint)
      .sort((a, b) => a.id.localeCompare(b.id));

    const catalogChanged =
      !initialized ||
      JSON.stringify(groups) !== JSON.stringify(sortedGroups) ||
      JSON.stringify(categories) !== JSON.stringify(sortedCategories);

    const pointsChanged =
      JSON.stringify(
        [...points].sort((a, b) => a.id.localeCompare(b.id))
      ) !== JSON.stringify(sortedPoints);

    if (catalogChanged) {
      applyCatalog(sortedGroups, sortedCategories);
    }

    points = sortedPoints;

    if (catalogChanged || pointsChanged || force) {
      render();
    }
  }

  function scheduleRefresh() {

    clearTimeout(refreshTimer);

    refreshTimer = setTimeout(() => {
      refresh().catch(fail);
    }, 400);
  }

  function commitCatalog(nextGroups, nextCategories) {

    if (!cloud) {

      localStorage.setItem(
        CATALOG,
        JSON.stringify({
          groups: nextGroups,
          categories: nextCategories
        })
      );
    }

    revision++;

    applyCatalog(nextGroups, nextCategories);

    render();
  }

  function commitPoints(nextPoints) {

    if (!cloud) {

      localStorage.setItem(
        STORAGE,
        JSON.stringify(nextPoints)
      );
    }

    revision++;

    points = nextPoints;

    render();
  }

  async function insertRow(table, row) {

    if (!cloud) return row;

    const { data, error } = await db
      .from(table)
      .insert(row)
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function updateRow(table, current, patch) {

    if (!cloud) return { ...current, ...patch };

    const { data, error } = await db
      .from(table)
      .update(patch)
      .eq('id', current.id)
      .select()
      .single();

    if (error) throw error;

    return data;
  }

  async function removeRow(table, id) {

    if (!cloud) return;

    const { error } = await db
      .from(table)
      .delete()
      .eq('id', id)
      .select('id')
      .single();

    if (error) throw error;
  }

  // ========================================
  // CRIAR CATEGORIAS PRINCIPAIS
  // ========================================

  async function createGroup(value) {

    const name = label(value);

    if (groups.some(g =>
      normalize(g.label) === normalize(name)
    )) {

      throw new Error('Essa categoria já existe.');
    }

    const normalizedName = normalize(name);

    let kind = 'outros';

    if (['mercador', 'mercadores'].includes(normalizedName)) {
      kind = 'mercador';
    }

    if (['cristal', 'cristais'].includes(normalizedName)) {
      kind = 'cristal';
    }

    const group = await insertRow(GROUPS, {

      id: uid('grupo_'),
      label: name,
      color: icons[kind].color,
      icon_kind: kind,
      sort_order: 1000

    });

    commitCatalog([...groups, group], categories);

    expanded.add(group.id);

    renderFilters();

    return group;
  }

  // ========================================
  // CRIAR SUBCATEGORIAS
  // ========================================

  async function createCategory(groupId, value) {

    const group = getGroup(groupId);

    if (!group) {
      throw new Error('Selecione uma categoria principal.');
    }

    const name = label(value);

    const findDuplicate = () => categories.find(c =>
      c.group_id === groupId &&
      normalize(c.label) === normalize(name)
    );

    const existing = findDuplicate();

    if (existing) return existing;

    const kind = validKind(group.icon_kind)
      ? group.icon_kind
      : 'outros';

    let category;

    try {

      category = await insertRow(CATEGORIES, {

        id: uid('sub_'),
        group_id: groupId,
        label: name,
        symbol: icons[kind].symbol,
        sort_order: 1000

      });

    } catch (error) {

      if (cloud && error.code === '23505') {

        await refresh(true);

        const duplicate = findDuplicate();

        if (duplicate) return duplicate;
      }

      throw error;
    }

    commitCatalog(groups, [...categories, category]);

    expanded.add(groupId);
    active.add(category.id);

    render();

    return category;
  }

  // ========================================
  // EDITAR CATEGORIAS
  // ========================================

  async function changeGroup(id, patch) {

    const current = getGroup(id);

    if (!current) {
      throw new Error('Categoria não encontrada.');
    }

    if (patch.label !== undefined) {

      patch.label = label(patch.label);

      if (groups.some(g =>
        g.id !== id &&
        normalize(g.label) === normalize(patch.label)
      )) {
        throw new Error('Já existe uma categoria com esse nome.');
      }
    }

    const updated = await updateRow(
      GROUPS, current, patch
    );

    commitCatalog(
      groups.map(g => g.id === id ? updated : g),
      categories
    );
  }

  async function renameCategory(id, value) {

    const current = getCategory(id);

    if (!current) {
      throw new Error('Subcategoria não encontrada.');
    }

    const name = label(value);

    if (categories.some(c =>
      c.id !== id &&
      c.group_id === current.group_id &&
      normalize(c.label) === normalize(name)
    )) {
      throw new Error('Essa subcategoria já existe.');
    }

    const updated = await updateRow(
      CATEGORIES, current, { label: name }
    );

    commitCatalog(
      groups,
      categories.map(c => c.id === id ? updated : c)
    );
  }

  // ========================================
  // EXCLUIR CATEGORIAS
  // ========================================

  async function deleteCategory(id) {

    if (points.some(p => p.category === id)) {

      throw new Error(
        'Essa subcategoria possui marcadores. ' +
        'Transfira ou exclua os locais primeiro.'
      );
    }

    await removeRow(CATEGORIES, id);

    commitCatalog(
      groups,
      categories.filter(c => c.id !== id)
    );
  }

  async function deleteGroup(id) {

    if (items(id).length) {

      throw new Error(
        'Remova as subcategorias antes de excluir o grupo.'
      );
    }

    await removeRow(GROUPS, id);

    commitCatalog(
      groups.filter(g => g.id !== id),
      categories
    );
  }

  // ========================================
  // GERENCIADOR DE CATEGORIAS
  // ========================================

  function fillSelect(select, rows, preferred) {

    select.replaceChildren();

    if (!rows.length) {

      const option = node(
        'option', '', 'Nenhuma opção disponível'
      );

      option.value = '';

      select.append(option);

      return;
    }

    for (const row of rows) {

      const option = node('option', '', row.label);

      option.value = row.id;

      select.append(option);
    }

    select.value = rows.some(r => r.id === preferred)
      ? preferred
      : rows[0].id;
  }

  function syncManager(
    groupId = $('managerGroup').value,
    categoryId = $('managerSubcategory').value
  ) {

    fillSelect($('managerGroup'), groups, groupId);

    const group = getGroup($('managerGroup').value);

    fillSelect(
      $('managerSubcategory'),
      items($('managerGroup').value),
      categoryId
    );

    $('groupIcon').value =
      validKind(group?.icon_kind)
        ? group.icon_kind
        : 'outros';

    managerControls();

    updateGroupIconPreview().catch(console.error);
  }

  function managerControls() {

    const hasGroup = Boolean(
      getGroup($('managerGroup').value)
    );

    const hasCategory = Boolean(
      getCategory($('managerSubcategory').value)
    );

    for (const id of [
      'renameGroup',
      'deleteGroup',
      'saveGroupIcon',
      'groupIcon',
      'newSubcategory'
    ]) {
      $(id).disabled = busy || !ready || !hasGroup;
    }

    for (const id of [
      'renameSubcategory',
      'deleteSubcategory'
    ]) {
      $(id).disabled = busy || !ready || !hasCategory;
    }
  }

  function managerTask(action) {
    return task(action, 'managerError');
  }

  function wireManager() {

    loadIconOptions();

    $('groupIcon').onchange = () => {
      updateGroupIconPreview().catch(console.error);
    };

    $('manageCategories').onclick = () => {

      if (busy || !ready || moving) return;

      endPlacement();

      $('managerError').textContent = '';

      syncManager();

      manager.showModal();
    };

    $('closeManager').onclick = () => {
      if (!busy) manager.close();
    };

    manager.addEventListener('cancel', e => {
      if (busy) e.preventDefault();
    });

    $('managerGroup').onchange = () => {
      syncManager($('managerGroup').value, '');
    };

    $('managerSubcategory').onchange = managerControls;

    $('newGroup').onclick = () => managerTask(async () => {

      const name = prompt('Nome da nova categoria principal:');

      if (name === null) return;

      const group = await createGroup(name);

      syncManager(group.id, '');
    });

    $('renameGroup').onclick = () => managerTask(async () => {

      const group = getGroup($('managerGroup').value);

      if (!group) return;

      const name = prompt('Novo nome:', group.label);

      if (name === null) return;

      await changeGroup(group.id, { label: name });

      syncManager(group.id);
    });

    $('deleteGroup').onclick = () => managerTask(async () => {

      const id = $('managerGroup').value;

      if (!confirm('Excluir esta categoria principal?')) return;

      await deleteGroup(id);

      syncManager();
    });

    // SALVAR ÍCONE DA CATEGORIA

    $('saveGroupIcon').onclick = () => {

      const kind = $('groupIcon').value;
      const groupId = $('managerGroup').value;

      managerTask(async () => {

        if (!validKind(kind)) {
          throw new Error('Ícone inválido.');
        }

        await changeGroup(groupId, {
          icon_kind: kind,
          color: icons[kind].color
        });

        const found = await findIconFile(kind);

        if (found) {

          toast('Ícone padrão atualizado!');

        } else {

          toast(
            'Ícone salvo, mas a imagem não foi encontrada. ' +
            'Confira a pasta icons.'
          );
        }
      });
    };

    $('newSubcategory').onclick = () => managerTask(async () => {

      const groupId = $('managerGroup').value;

      const name = prompt('Nome da nova subcategoria:');

      if (name === null) return;

      const c = await createCategory(groupId, name);

      syncManager(groupId, c.id);
    });

    $('renameSubcategory').onclick = () => managerTask(async () => {

      const c = getCategory($('managerSubcategory').value);

      if (!c) return;

      const name = prompt('Novo nome:', c.label);

      if (name === null) return;

      await renameCategory(c.id, name);

      syncManager(c.group_id, c.id);
    });

    $('deleteSubcategory').onclick = () => managerTask(async () => {

      const id = $('managerSubcategory').value;

      if (!confirm('Excluir esta subcategoria?')) return;

      await deleteCategory(id);

      syncManager();
    });
  }

  // ========================================
  // FORMULÁRIO DE CADASTRO
  // ========================================

  function editorOptions(groupId, categoryId) {

    fillSelect($('mainCategory'), groups, groupId);

    const group = $('mainCategory').value;

    const options = items(group).map(c => ({
      id: c.id,
      label: categoryLabel(c.id)
    }));

    if (group) {

      options.push({
        id: NEW,
        label: '＋ Criar nova subcategoria'
      });
    }

    fillSelect($('category'), options, categoryId);

    updateNewCategory();
  }

  function updateNewCategory() {

    const creating = $('category').value === NEW;

    $('newCategoryBox').hidden = !creating;
    $('newCategoryName').required = creating;
  }

  function previewImages() {

    for (const [key, id] of [
      ['icon', 'iconPreview'],
      ['photo', 'photoPreview']
    ]) {

      const image = $(id);

      if (safeImage(draft?.[key])) {

        image.src = draft[key];
        image.hidden = false;

      } else {

        image.removeAttribute('src');
        image.hidden = true;
      }
    }
  }

  function openEditor(point) {

    if (busy || !ready || moving) return;

    endPlacement();

    draft = { ...point };

    $('editorTitle').textContent =
      point.id ? 'Editar local' : 'Novo local';

    $('name').value = point.name || '';
    $('description').value = point.description || '';

    $('newCategoryName').value = '';
    $('iconFile').value = '';
    $('photoFile').value = '';

    $('delete').hidden = !point.id;

    $('formError').textContent = '';

    $('positionLabel').textContent =
      `Posição: X ${Math.round(point.lng)} · Y ${Math.round(point.lat)}`;

    editorOptions(
      groupOf(point.category)?.id || groups[0]?.id,
      point.category
    );

    previewImages();

    const photoDetails =
      editor.querySelector('.optional-photo');

    if (photoDetails) photoDetails.open = false;

    if (!editor.open) editor.showModal();

    $('name').focus();
  }

  function closeEditor() {

    if (busy) return;

    editor.close();

    draft = null;
  }

  function beginPlacement() {

    if (busy || moving || !ready) return;

    if (!groups.length) {

      toast('Crie uma categoria principal primeiro.');

      return;
    }

    placing = true;

    map.closePopup();

    $('placement').hidden = false;
    $('workspace').classList.add('placing');

    if (innerWidth <= 700) toggleSidebar(true);
  }

  function endPlacement() {

    placing = false;

    $('placement').hidden = true;
    $('workspace').classList.remove('placing');
  }

  // ========================================
  // SALVAR E EXCLUIR LOCAIS
  // ========================================

  async function savePoint(point) {

    const name = clean(point.name);

    if (!name || name.length > 100) {

      throw new Error('Informe um nome de até 100 caracteres.');
    }

    if (!getCategory(point.category)) {

      throw new Error('A subcategoria selecionada não existe.');
    }

    const data = {

      name,
      category: point.category,
      description: String(point.description || '').slice(0, 2000),
      lat: clamp(point.lat),
      lng: clamp(point.lng),
      icon: safeImage(point.icon) ? point.icon : null,
      photo: safeImage(point.photo) ? point.photo : null

    };

    let row;

    if (point.id) {

      row = await updateRow(LOCATIONS, point, data);

    } else if (cloud) {

      row = await insertRow(LOCATIONS, data);

    } else {

      row = {
        ...data,
        id: crypto.randomUUID(),
        created_at: new Date().toISOString()
      };
    }

    active.add(row.category);

    const groupId = groupOf(row.category)?.id;

    if (groupId) expanded.add(groupId);

    commitPoints(
      points.filter(p => p.id !== row.id).concat(row)
    );
  }

  async function deletePoint(id) {

    await removeRow(LOCATIONS, id);

    commitPoints(
      points.filter(p => p.id !== id)
    );
  }

  // ========================================
  // COMPRESSÃO DE IMAGENS
  // ========================================

  async function compressImage(file, dimension, maxLength, png) {

    if (![
      'image/png',
      'image/jpeg',
      'image/webp'
    ].includes(file.type)) {

      throw new Error('Escolha uma imagem PNG, JPG ou WebP.');
    }

    if (file.size > 12 * 1024 * 1024) {

      throw new Error('Escolha uma imagem com até 12 MB.');
    }

    const url = URL.createObjectURL(file);

    try {

      const image = new Image();

      image.src = url;

      await image.decode();

      let size = dimension;

      for (let i = 0; i < 7; i++) {

        const ratio = Math.min(
          1, size / Math.max(image.width, image.height)
        );

        const canvas = document.createElement('canvas');

        canvas.width = Math.max(
          1, Math.round(image.width * ratio)
        );

        canvas.height = Math.max(
          1, Math.round(image.height * ratio)
        );

        canvas.getContext('2d').drawImage(
          image, 0, 0, canvas.width, canvas.height
        );

        let result = png
          ? canvas.toDataURL('image/png')
          : canvas.toDataURL('image/webp', .82);

        if (safeImage(result) && result.length <= maxLength) {
          return result;
        }

        result = canvas.toDataURL('image/webp', .72);

        if (safeImage(result) && result.length <= maxLength) {
          return result;
        }

        size *= .72;
      }

      throw new Error('Não foi possível reduzir a imagem.');

    } finally {

      URL.revokeObjectURL(url);
    }
  }

  function wireUpload(key, id, size, limit) {

    $(id).onchange = () => {

      const file = $(id).files[0];

      if (!file || !draft || busy) return;

      task(async () => {

        try {

          draft[key] = await compressImage(
            file, size, limit, key === 'icon'
          );

          previewImages();

        } finally {

          $(id).value = '';
        }

      }, 'formError');
    };
  }

  // ========================================
  // CONTROLES DO SITE
  // ========================================

  function wireControls() {

    $('toggleSidebar').onclick = () => {

      toggleSidebar(
        !$('workspace').classList.contains('collapsed')
      );
    };

    $('search').oninput = render;

    $('resetFilters').onclick = () => {

      active = new Set(categories.map(c => c.id));

      render();
    };

    $('clearFilters').onclick = () => {

      active.clear();

      render();
    };

    $('add').onclick = beginPlacement;
    $('cancelPlacement').onclick = endPlacement;
    $('closeEditor').onclick = closeEditor;
    $('cancelEditor').onclick = closeEditor;

    $('mainCategory').onchange = () => {

      $('newCategoryName').value = '';

      editorOptions($('mainCategory').value, '');
    };

    $('category').onchange = updateNewCategory;

    editor.addEventListener('cancel', event => {

      if (busy) {
        event.preventDefault();
      } else {
        draft = null;
      }
    });

    $('removeIcon').onclick = () => {

      if (draft && !busy) {

        draft.icon = null;

        previewImages();
      }
    };

    $('removePhoto').onclick = () => {

      if (draft && !busy) {

        draft.photo = null;

        previewImages();
      }
    };

    wireUpload('icon', 'iconFile', 128, 120000);
    wireUpload('photo', 'photoFile', 900, 350000);

    // SALVAR LOCAL

    $('editorForm').onsubmit = event => {

      event.preventDefault();

      if (!draft || busy || !ready) return;

      const name = $('name').value;
      const description = $('description').value;
      const groupId = $('mainCategory').value;

      let categoryId = $('category').value;

      const newName = $('newCategoryName').value;

      task(async () => {

        if (!clean(name) || clean(name).length > 100) {

          throw new Error('Informe um nome válido para o local.');
        }

        if (categoryId === NEW) {

          const category = await createCategory(
            groupId, newName
          );

          categoryId = category.id;

          editorOptions(groupId, categoryId);
        }

        await savePoint({
          ...draft,
          name,
          description,
          category: categoryId
        });

        editor.close();

        draft = null;

        map.closePopup();

        toast('Local salvo com sucesso!');

      }, 'formError');
    };

    // EXCLUIR LOCAL

    $('delete').onclick = () => {

      if (!draft?.id || busy) return;

      if (!confirm('Excluir este local?')) return;

      task(async () => {

        await deletePoint(draft.id);

        editor.close();

        draft = null;

        toast('Local excluído.');

      }, 'formError');
    };

    // COMPARTILHAR

    $('share').onclick = async () => {

      if (!cloud) {

        toast(
          'Configure o Supabase e publique o site para compartilhar.'
        );

        return;
      }

      try {

        await navigator.clipboard.writeText(location.href);

        toast('Link copiado!');

      } catch {

        prompt('Copie o link:', location.href);
      }
    };

    // EXPORTAR BACKUP

    $('export').onclick = () => {

      if (!ready) return;

      const backup = {
        version: 2,
        groups,
        categories,
        locations: points
      };

      const blob = new Blob(
        [JSON.stringify(backup, null, 2)],
        { type: 'application/json' }
      );

      const url = URL.createObjectURL(blob);

      const link = document.createElement('a');

      link.href = url;

      link.download =
        'mapa-de-aletheia-backup-' +
        new Date().toISOString().slice(0, 10) +
        '.json';

      link.click();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    // ATALHO ESC

    addEventListener('keydown', event => {

      if (event.key !== 'Escape') return;

      if (placing) endPlacement();

      if (moving) {

        markers.get(moving)?.dragging.disable();

        moving = null;

        render();

        toast('Movimentação cancelada.');
      }
    });

    // SINCRONIZAÇÃO

    addEventListener('storage', event => {

      if (
        !cloud &&
        [STORAGE, CATALOG].includes(event.key)
      ) {
        scheduleRefresh();
      }
    });

    addEventListener('focus', () => {

      if (cloud && db && ready) {
        scheduleRefresh();
      }
    });

    wireManager();
  }

  // ========================================
  // INICIAR SISTEMA
  // ========================================

  async function start() {

    if (!window.L) {

      status('Falha ao carregar mapa', 'offline');

      toast('Leaflet não carregou. Confira sua internet.');

      return;
    }

    initMap();

    wireControls();

    lock(true);

    if (innerWidth <= 700) toggleSidebar(true);

    try {

      if (cloud) {

        status('Conectando...');

        if (!window.supabase) {

          throw new Error('Supabase não carregou.');
        }

        db = window.supabase.createClient(
          config.supabaseUrl,
          config.supabaseKey,
          {
            auth: {
              persistSession: false,
              autoRefreshToken: false,
              detectSessionInUrl: false
            }
          }
        );
      }

      await refresh(true);

      ready = true;

      if (!cloud) {

        status('Modo local');

        return;
      }

      status('Banco conectado', 'online');

      let channel = db.channel(
        'aletheia-collaborative-v2'
      );

      for (const table of [GROUPS, CATEGORIES, LOCATIONS]) {

        channel = channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table
          },
          scheduleRefresh
        );
      }

      channel.subscribe(state => {

        if (state === 'SUBSCRIBED') {

          status('Colaborativo · online', 'online');

          scheduleRefresh();

        } else if ([
          'CHANNEL_ERROR',
          'TIMED_OUT',
          'CLOSED'
        ].includes(state)) {

          status('Sincronização instável', 'offline');
        }
      });

      setInterval(() => {

        if (
          document.visibilityState === 'visible' &&
          !busy &&
          !moving
        ) {

          scheduleRefresh();
        }

      }, 20000);

    } catch (error) {

      status('Erro ao carregar dados', 'offline');

      fail(error);

    } finally {

      lock(false);
    }
  }

  start().catch(fail);

})();