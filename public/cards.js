// Shared card rendering. Card string like "Ah", "Td", "??" for hidden.
const SUIT = { h: '♥', d: '♦', c: '♣', s: '♠' };
export function cardEl(card) {
  const el = document.createElement('div');
  el.className = 'card';
  if (!card || card === '??') { el.classList.add('back'); return el; }
  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  const red = suit === 'h' || suit === 'd';
  el.classList.toggle('red', red);
  el.innerHTML = `<span class="r">${rank}</span><span class="s">${SUIT[suit]}</span>`;
  return el;
}
export function renderCards(container, cards) {
  container.innerHTML = '';
  for (const c of cards || []) container.appendChild(cardEl(c));
}
