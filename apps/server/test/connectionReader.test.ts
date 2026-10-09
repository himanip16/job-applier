import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { readConnections } from '../src/linkedin/connectionReader.js';

let browser: Browser;
let page: Page;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); });

const card = (slug: string, name: string, headline = 'Engineer at Acme, Inc.') => `
  <li class="mn-connection-card">
    <a href="https://www.linkedin.com/in/${slug}?tracking=photo"><img alt=""></a>
    <div><a href="https://www.linkedin.com/in/${slug}/"><span class="mn-connection-card__name">${name}</span></a>
    <p class="mn-connection-card__occupation">${headline}</p><p>Connected on September 9, 2026</p></div>
    <button>Message</button>
  </li>`;

async function open(html: string) {
  page = await browser.newPage();
  await page.setContent(html);
  return page;
}

describe('connection card reader', () => {
  it('reads the text link after a blank photo link and keeps explicit fields separate', async () => {
    await open(`<nav><a href="https://www.linkedin.com/in/me">My profile</a></nav><main><ul>
      ${card('alice', 'Alice', 'Technical Recruiter at Acme, Inc. | Hiring')}
      ${card('bob', 'Bob', 'Data Engineer')}
      ${card('alice', 'Alice', 'Technical Recruiter at Acme, Inc. | Hiring')}
    </ul></main>`);
    const result = await readConnections(page, { delayMs: 1 });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ fullName: 'Alice', headline: 'Technical Recruiter at Acme, Inc. | Hiring', companyName: 'Acme, Inc.', degree: '1st', profileUrl: 'https://www.linkedin.com/in/alice' });
    expect(result[0]?.location).toBeUndefined();
    expect(result[1]?.companyName).toBeUndefined();
  });

  it('reads generated-class cards while excluding suggestions and hidden cards', async () => {
    await open(`<main><div>
      <div><a href="https://www.linkedin.com/in/cara"><img alt=""></a><div data-view-name="profile-link"><a href="https://www.linkedin.com/in/cara"><p>Cara</p></a></div><p>Engineering Manager @ Example Labs</p><button aria-label="Message Cara">Message</button></div>
      <div><a href="https://www.linkedin.com/in/suggestion">Suggested Person</a><p>CEO at Other</p><button>Connect</button></div>
      <div hidden>${card('hidden', 'Hidden')}</div>
    </div></main>`);
    const result = await readConnections(page, { delayMs: 1 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ fullName: 'Cara', headline: 'Engineering Manager @ Example Labs', companyName: 'Example Labs' });
  });

  it('collects cards before a virtual list replaces them with the same number of cards', async () => {
    await open(`<main><div id="scroller" style="height:120px;overflow-y:auto"><ul id="cards">${card('first', 'First')}</ul><div style="height:700px"></div></div></main>
      <script>document.querySelector('#scroller').addEventListener('scroll', () => { document.querySelector('#cards').innerHTML = ${JSON.stringify(card('second', 'Second'))}; }, {once:true});</script>`);
    const saved: string[] = [];
    const result = await readConnections(page, { delayMs: 20, onConnection: async (connection) => { saved.push(connection.fullName); } });
    expect(result.map((connection) => connection.fullName)).toEqual(['First', 'Second']);
    expect(saved).toEqual(['First', 'Second']);
  });

  it('uses Show more and Next page controls', async () => {
    await open(`<main><ul id="cards">${card('one', 'One')}</ul><button id="more">Show more results</button>
      <nav aria-label="Pagination"><button id="next">Next</button></nav></main>
      <script>
        document.querySelector('#more').onclick = function () { document.querySelector('#cards').insertAdjacentHTML('beforeend', ${JSON.stringify(card('two', 'Two'))}); this.remove(); };
        document.querySelector('#next').onclick = function () { document.querySelector('#cards').innerHTML = ${JSON.stringify(card('three', 'Three'))}; this.disabled = true; };
      </script>`);
    expect((await readConnections(page, { delayMs: 1 })).map((connection) => connection.fullName)).toEqual(['One', 'Two', 'Three']);
  });

  it('waits for delayed initial cards', async () => {
    await open(`<main><ul id="cards"></ul></main><script>setTimeout(() => { document.querySelector('#cards').innerHTML = ${JSON.stringify(card('late', 'Late'))}; }, 40);</script>`);
    expect((await readConnections(page, { delayMs: 30 }))[0]?.fullName).toBe('Late');
  });

  it('reports an incomplete read when a load-more control never finishes', async () => {
    await open(`<main><ul>${card('saved', 'Saved')}</ul><button>Load more connections</button></main>`);
    const save = vi.fn();
    await expect(readConnections(page, { maxPasses: 3, delayMs: 1, onConnection: save })).rejects.toThrow('sync is incomplete');
    expect(save).toHaveBeenCalledTimes(1);
  });
});
