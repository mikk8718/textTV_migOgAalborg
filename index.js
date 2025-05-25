import inquirer from 'inquirer';
import puppeteer from 'puppeteer';

async function scrapeArticles(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  while (true) {
    try {
      await page.waitForSelector('button.tpo\\:label.is-button', { timeout: 3000 });
      const isVisible = await page.$eval('button.tpo\\:label.is-button', btn => btn.offsetParent !== null);
      if (!isVisible) break;

      console.log('Indlæser artikler...');
      await page.click('button.tpo\\:label.is-button');
      await page.waitForTimeout(1500);
    } catch {
      break;
    }
  }

  await page.waitForSelector('a.tpo\\:article-thumb--link');

  const articles = await page.$$eval('article', articles =>
    articles.map(article => {
      const title = article.querySelector('h3')?.innerText.trim();
      const link = article.querySelector('a.tpo\\:article-thumb--link')?.href;
      return title && link ? { title, link } : null;
    }).filter(Boolean)
  );

  await page.close();
  return articles;
}

async function printArticleContent(browser, url) {
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const content = await page.$$eval('article p', paragraphs =>
    paragraphs.map(p => p.innerText.trim()).filter(Boolean).join('\n\n')
  );

  console.clear();
  console.log(`${url}\n`);
  console.log(content);
  console.log('\n🧾 Ende på artikel\n');

  await page.close();
}

async function main() {
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('https://migogaalborg.dk/', { waitUntil: 'domcontentloaded' });

  const links = await page.$$eval('li.menu-item a', anchors =>
    anchors.map(a => ({
      href: a.href,
      text: a.textContent.trim()
    }))
  );

  const agreedCategories = [
    'Nyheder i Aalborg',
    'Det sker i Aalborg',
    'Mad i byen',
    'Shopping',
    'Musik og kultur'
  ];

  const seen = new Set();
  const unique = links.filter(item => {
    const t = item.text;
    if (!agreedCategories.includes(t) || seen.has(t)) return false;
    seen.add(t);
    return true;
  });

  const categoryChoices = unique.map(item => ({
    name: item.text,
    value: item
  }));

  categoryChoices.push(new inquirer.Separator(), { name: 'Exit', value: 'exit' });

  while (true) {
    console.clear(); // Clear terminal before category prompt
    const { category } = await inquirer.prompt([
      {
        type: 'list',
        name: 'category',
        message: '📚 Vælg en kategori:',
        choices: categoryChoices
      }
    ]);

    if (category === 'exit') {
      await browser.close();
      process.exit(0);
    }

    const categoryName = category.text;
    const categoryUrl = category.href;
    let articles = await scrapeArticles(browser, categoryUrl);
    console.log(articles.length);

    while (true) {
      const seen = new Set();
      const articleChoices = articles
        .filter(article => {
          if (seen.has(article.title)) return false;
          seen.add(article.title);
          return true;
        })
        .map(article => ({
          name: article.title,
          value: article.link
        }));

      articleChoices.push(
        new inquirer.Separator(),
        { name: '⬅️ Tilbage til kategorier', value: 'back_to_categories' },
        { name: '❌ Afslut', value: 'exit' }
      );

      const { selectedArticle } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedArticle',
          message: `📖 Vælg en artikel i "${categoryName}":`,
          choices: articleChoices,
          pageSize: articleChoices.length
        }
      ]);

      if (selectedArticle === 'back_to_categories') break;
      if (selectedArticle === 'exit') {
        await browser.close();
        process.exit(0);
      }

      await printArticleContent(browser, selectedArticle);

      const { afterRead } = await inquirer.prompt([
        {
          type: 'list',
          name: 'afterRead',
          message: '🧭 Hvad vil du nu?',
          choices: [
            { name: `🔁 Tilbage til "${categoryName}"`, value: 'same_category' },
            { name: '🗂️ Vælg en anden kategori', value: 'back_to_categories' },
            { name: '❌ Afslut', value: 'exit' }
          ]
        }
      ]);

      if (afterRead === 'exit') {
        await browser.close();
        process.exit(0);
      } else if (afterRead === 'back_to_categories') {
        break;
      }
      // Otherwise, continue in current category
    }
  }
}

main();
