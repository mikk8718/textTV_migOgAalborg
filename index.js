import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import * as cheerio from 'cheerio';

const FRONT_PAGE_URL = 'https://migogaalborg.dk/';
const WIDTH = 78;
const BODY_LINES = 22;
const ARTICLES_PER_BATCH = 8;
const MAX_ARTICLES_PER_CATEGORY = 40;
const HOME_PAGE = 100;
const CATEGORY_PAGES = [
  { page: 110, name: 'Nyheder i Aalborg' },
  { page: 120, name: 'Mad i byen' },
  { page: 130, name: 'Musik og kultur' },
  { page: 140, name: 'Shopping' }
];

const ansi = {
  reset: '\x1b[0m',
  clear: '\x1b[2J\x1b[H',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

const state = {
  categories: [],
  categoryStates: new Map(),
  articleCache: new Map(),
  currentPage: HOME_PAGE,
  currentArticlePart: 0,
  previousPage: HOME_PAGE
};

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 textTV_migOgAalborg/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Kunne ikke hente ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 textTV_migOgAalborg/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`Kunne ikke hente data: ${response.status} ${response.statusText}`);
  }

  return {
    data: await response.json(),
    totalPages: Number(response.headers.get('x-wp-totalpages')) || null
  };
}

function decodeHtml(value) {
  return cheerio.load(value).text().trim();
}

function getCategoryState(category) {
  if (!state.categoryStates.has(category.page)) {
    state.categoryStates.set(category.page, {
      articles: [],
      loadedPages: 0,
      totalPages: null,
      visibleBatch: 0
    });
  }

  return state.categoryStates.get(category.page);
}

function visibleArticlesFor(category) {
  const categoryState = getCategoryState(category);
  const start = categoryState.visibleBatch * ARTICLES_PER_BATCH;

  return categoryState.articles
    .slice(start, start + ARTICLES_PER_BATCH)
    .map((article, index) => ({
      ...article,
      page: category.page + index + 1,
      categoryPage: category.page
    }));
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(value) {
  return stripAnsi(value).length;
}

function padLine(value = '') {
  const cleanLength = visibleLength(value);
  return cleanLength >= WIDTH ? value : `${value}${' '.repeat(WIDTH - cleanLength)}`;
}

function truncate(value, maxLength = WIDTH) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function color(value, code) {
  return `${code}${value}${ansi.reset}`;
}

function teletextLine(value = '', code = ansi.white) {
  return padLine(color(truncate(value), code));
}

function wrapText(text, maxLength = WIDTH) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const lines = [];
  let line = '';

  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= maxLength) {
      line = `${line} ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function chunkLines(lines, size) {
  const chunks = [];
  for (let i = 0; i < lines.length; i += size) {
    chunks.push(lines.slice(i, i + size));
  }
  return chunks.length ? chunks : [[]];
}

function formatDate() {
  return new Intl.DateTimeFormat('da-DK', {
    day: '2-digit',
    month: 'short'
  }).format(new Date()).toUpperCase();
}

function renderFrame(page, title, bodyLines, footer = 'SIDE: 100  TILBAGE: 0  AFSLUT: Q') {
  const date = formatDate();
  const pageLabel = `TV ${String(page).padStart(3, '0')}  `;
  const titleWidth = WIDTH - pageLabel.length - date.length - 1;
  const header = `${pageLabel}${truncate(title, titleWidth)}`.padEnd(WIDTH - date.length, ' ');
  const lines = [
    `${ansi.clear}${color('█'.repeat(WIDTH), ansi.blue)}`,
    padLine(`${color(header, ansi.yellow)}${color(date, ansi.cyan)}`),
    color('█'.repeat(WIDTH), ansi.blue),
    ''
  ];

  for (const line of bodyLines.slice(0, BODY_LINES)) {
    lines.push(line);
  }

  while (lines.length < BODY_LINES + 4) {
    lines.push('');
  }

  lines.push(color('─'.repeat(WIDTH), ansi.blue));
  lines.push(teletextLine(footer, ansi.yellow));
  lines.push(ansi.reset);
  console.log(lines.map(padLine).join('\n'));
}

async function loadCategories() {
  const { data: categories } = await fetchJson(`${FRONT_PAGE_URL}wp-json/wp/v2/categories?per_page=100`);

  state.categories = CATEGORY_PAGES
    .map(category => {
      const match = categories.find(item => item.name === category.name);
      if (!match) return null;
      return {
        ...category,
        id: match.id,
        url: match.link,
        totalCount: match.count
      };
    })
    .filter(Boolean);
}

async function loadArticles(category, { more = false } = {}) {
  const categoryState = getCategoryState(category);

  if (!more && categoryState.articles.length) {
    return visibleArticlesFor(category);
  }

  if (more && categoryState.articles.length >= MAX_ARTICLES_PER_CATEGORY) {
    return visibleArticlesFor(category);
  }

  if (more && categoryState.totalPages && categoryState.loadedPages >= categoryState.totalPages) {
    return visibleArticlesFor(category);
  }

  if (!more || categoryState.loadedPages === 0) {
    categoryState.articles = [];
    categoryState.loadedPages = 0;
    categoryState.totalPages = null;
    categoryState.visibleBatch = 0;
  } else {
    categoryState.visibleBatch += 1;
  }

  const nextPage = categoryState.loadedPages + 1;
  const url = `${FRONT_PAGE_URL}wp-json/wp/v2/posts?categories=${category.id}&per_page=${ARTICLES_PER_BATCH}&page=${nextPage}&_fields=id,link,title`;
  const { data: posts, totalPages } = await fetchJson(url);
  const seenLinks = new Set(categoryState.articles.map(article => article.link));
  const nextArticles = posts
    .map(post => ({
      id: post.id,
      title: decodeHtml(post.title.rendered),
      link: post.link
    }))
    .filter(article => article.title && article.link && !seenLinks.has(article.link));

  categoryState.totalPages = totalPages || categoryState.totalPages;
  categoryState.articles.push(...nextArticles);
  categoryState.articles = categoryState.articles.slice(0, MAX_ARTICLES_PER_CATEGORY);
  categoryState.loadedPages = nextPage;

  return visibleArticlesFor(category);
}

async function loadArticle(article) {
  if (state.articleCache.has(article.link)) {
    return state.articleCache.get(article.link);
  }

  const html = await fetchPage(article.link);
  const $ = cheerio.load(html);
  const paragraphs = $('article p')
    .map((_, paragraph) => $(paragraph).text().trim())
    .get()
    .filter(Boolean);
  const text = paragraphs.join('\n\n') || 'Ingen artikeltekst fundet.';
  const lines = [
    ...wrapText(article.title.toUpperCase()),
    '',
    ...text.split('\n\n').flatMap(paragraph => [...wrapText(paragraph), ''])
  ];
  const pages = chunkLines(lines, BODY_LINES);
  const articlePage = { ...article, pages };

  state.articleCache.set(article.link, articlePage);
  return articlePage;
}

function renderHome() {
  const lines = [
    teletextLine('MIG OG AALBORG TEXT TV', ansi.yellow),
    teletextLine('Lokale overskrifter i klassisk tekst-tv form.', ansi.white),
    '',
    ...state.categories.map(category =>
      teletextLine(`${category.page}  ${category.name.toUpperCase()}`, ansi.cyan)
    ),
    '',
    teletextLine('TAST SIDETAL OG TRYK ENTER', ansi.yellow),
    teletextLine('R  OPDATER  ·  Q  AFSLUT', ansi.white)
  ];

  renderFrame(HOME_PAGE, 'MIG OG AALBORG', lines, 'INDTAST SIDE: 110-140  AFSLUT: Q');
}

async function renderCategory(category) {
  const articles = await loadArticles(category);
  const categoryState = getCategoryState(category);
  const firstVisible = categoryState.visibleBatch * ARTICLES_PER_BATCH + 1;
  const lastVisible = categoryState.visibleBatch * ARTICLES_PER_BATCH + articles.length;
  const totalText = category.totalCount ? ` / ${Math.min(category.totalCount, MAX_ARTICLES_PER_CATEGORY)}` : '';
  const hasMore = categoryState.articles.length < MAX_ARTICLES_PER_CATEGORY
    && (!categoryState.totalPages || categoryState.loadedPages < categoryState.totalPages);
  const lines = [
    teletextLine(category.name.toUpperCase(), ansi.yellow),
    teletextLine(`Viser ${articles.length ? firstVisible : 0}-${lastVisible}${totalText}`, ansi.cyan),
    ''
  ];

  if (!articles.length) {
    lines.push(teletextLine('Ingen artikler fundet.', ansi.red));
  } else {
    lines.push(...articles.map(article =>
      teletextLine(`${article.page}  ${article.title}`, ansi.white)
    ));
  }

  lines.push('', teletextLine(hasMore ? 'M  HENT FLERE ARTIKLER' : 'IKKE FLERE ARTIKLER I DENNE VISNING', ansi.cyan));
  lines.push(teletextLine('VÆLG ARTIKEL ELLER 100 FOR FORSIDE', ansi.cyan));
  renderFrame(category.page, category.name.toUpperCase(), lines, 'SIDE: 100  M: FLERE  TILBAGE: 0  OPDATER: R  AFSLUT: Q');
}

async function renderArticle(articlePage, part = 0) {
  const article = await loadArticle(articlePage);
  const safePart = Math.max(0, Math.min(part, article.pages.length - 1));
  state.currentArticlePart = safePart;

  const partLabel = article.pages.length > 1 ? ` ${safePart + 1}/${article.pages.length}` : '';
  const lines = article.pages[safePart].map(line => teletextLine(line, ansi.white));
  const footerParts = ['SIDE: 100', 'TILBAGE: 0'];

  if (safePart > 0) footerParts.push('P: FORRIGE');
  if (safePart < article.pages.length - 1) footerParts.push('N: NÆSTE');

  footerParts.push('AFSLUT: Q');
  renderFrame(article.page, `${article.title.toUpperCase()}${partLabel}`, lines, footerParts.join('  '));
}

function findCategory(page) {
  return state.categories.find(category => category.page === page);
}

function findArticle(page) {
  for (const category of state.categories) {
    const match = visibleArticlesFor(category).find(article => article.page === page);
    if (match) return match;
  }

  const category = state.categories.find(item => page > item.page && page < item.page + ARTICLES_PER_BATCH + 1);
  if (!category) return null;

  return { categoryPage: category.page, pendingPage: page };
}

async function renderPage(page) {
  if (page === HOME_PAGE) {
    state.previousPage = state.currentPage;
    state.currentPage = HOME_PAGE;
    renderHome();
    return;
  }

  const category = findCategory(page);
  if (category) {
    state.previousPage = state.currentPage;
    state.currentPage = page;
    await renderCategory(category);
    return;
  }

  const article = findArticle(page);
  if (article?.pendingPage) {
    const pendingCategory = findCategory(article.categoryPage);
    await loadArticles(pendingCategory);
    return renderPage(page);
  }

  if (article) {
    state.previousPage = state.currentPage;
    state.currentPage = page;
    await renderArticle(article, 0);
    return;
  }

  renderFrame(404, 'SIDEN FINDES IKKE', [
    teletextLine(`Siden ${page} findes ikke.`, ansi.red),
    '',
    teletextLine('Prøv 100 for forsiden.', ansi.white)
  ], 'SIDE: 100  TILBAGE: 0  AFSLUT: Q');
}

async function refreshCurrentPage() {
  state.categoryStates.clear();
  state.articleCache.clear();
  await loadCategories();
  await renderPage(state.currentPage);
}

async function loadMoreForCurrentCategory() {
  const category = findCategory(state.currentPage);

  if (!category) {
    renderFrame(400, 'MERE VIRKER HER IKKE', [
      teletextLine('M kan kun bruges på en kategoriside.', ansi.red),
      '',
      teletextLine('Gå til 110, 120, 130 eller 140 først.', ansi.white)
    ], 'SIDE: 100  TILBAGE: 0  AFSLUT: Q');
    return;
  }

  await loadArticles(category, { more: true });
  await renderCategory(category);
}

async function handleCommand(command) {
  const normalized = command.trim().toLowerCase();
  if (!normalized) return renderPage(state.currentPage);
  if (normalized === 'q' || normalized === 'quit' || normalized === 'exit') return false;
  if (normalized === 'r') return refreshCurrentPage();
  if (normalized === '0') return renderPage(state.previousPage || HOME_PAGE);
  if (normalized === 'm') return loadMoreForCurrentCategory();

  const currentArticle = findArticle(state.currentPage);
  if (currentArticle && normalized === 'n') {
    return renderArticle(currentArticle, state.currentArticlePart + 1);
  }
  if (currentArticle && normalized === 'p') {
    return renderArticle(currentArticle, state.currentArticlePart - 1);
  }

  const page = Number.parseInt(normalized, 10);
  if (Number.isNaN(page)) {
    renderFrame(400, 'UKENDT KOMMANDO', [
      teletextLine(`Ukendt kommando: ${command}`, ansi.red),
      '',
      teletextLine('Brug sidetal, 0, M, R, N, P eller Q.', ansi.white)
    ], 'SIDE: 100  TILBAGE: 0  AFSLUT: Q');
    return;
  }

  return renderPage(page);
}

async function main() {
  const rl = createInterface({ input, output });

  try {
    await loadCategories();
    renderHome();

    while (true) {
      const command = await rl.question(`${ansi.yellow}INDTAST SIDE > ${ansi.reset}`);
      const result = await handleCommand(command);
      if (result === false) break;
    }
  } catch (err) {
    console.error(`${ansi.reset}Fejl: ${err.message}`);
  } finally {
    rl.close();
    console.log(ansi.reset);
  }
}

main();
