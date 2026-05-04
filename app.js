const meals = ["아침", "점심", "간식", "저녁"];
const mealColors = {
  "아침": "var(--yellow)",
  "점심": "var(--blue)",
  "간식": "var(--pink)",
  "저녁": "var(--violet)",
};
const goal = 1450;
const state = {
  date: new Date().toISOString().slice(0, 10),
  foods: [],
  entries: [],
  searchResults: [],
};

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  $("status").textContent = message;
  $("status").style.color = isError ? "#b91c1c" : "var(--muted)";
}

function token() {
  return localStorage.getItem("calorieToken") || "";
}

function supabaseSettings() {
  return {
    url: (localStorage.getItem("supabaseUrl") || "").replace(/\/$/, ""),
    key: localStorage.getItem("supabaseKey") || "",
  };
}

function supabaseHeaders(write = false) {
  const { key } = supabaseSettings();
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (token()) headers["x-calorie-token"] = token();
  if (write) {
    headers.prefer = "return=representation";
  }
  return headers;
}

async function supabaseFetch(path, options = {}) {
  const { url, key } = supabaseSettings();
  if (!url || !key) throw new Error("Supabase URL과 publishable key를 먼저 저장해 주세요.");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { ...supabaseHeaders(Boolean(options.method && options.method !== "GET")), ...(options.headers || {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(data?.message || data?.hint || "Supabase 요청 실패");
  return data;
}

async function openFoodFactsSearch(query) {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: "1",
    action: "process",
    json: "1",
    page_size: "8",
    fields: "product_name,product_name_ko,generic_name,brands,categories,nutriments,url",
  });
  const response = await fetch(`https://world.openfoodfacts.org/cgi/search.pl?${params}`);
  if (!response.ok) throw new Error(`Open Food Facts 검색 실패: ${response.status}`);
  const data = await response.json();
  return (data.products || [])
    .map((product) => {
      const nutriments = product.nutriments || {};
      const kcal = Number(nutriments["energy-kcal_100g"] ?? nutriments["energy-kcal"] ?? 0);
      const name = product.product_name_ko || product.product_name || product.generic_name || "";
      if (!name.trim() || !Number.isFinite(kcal) || kcal <= 0) return null;
      return {
        name: name.trim(),
        brand: product.brands || "",
        kcal_per_100: Math.round(kcal),
        unit: "g",
        category: product.categories || "검색 결과",
        notes: "Open Food Facts 검색 결과",
        source: "Open Food Facts",
        source_url: product.url || "",
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

async function api(path, options = {}) {
  const configured = Boolean(supabaseSettings().url && supabaseSettings().key);
  if (configured) {
    if (path === "/api/foods" && (!options.method || options.method === "GET")) {
      const foods = await supabaseFetch("foods?select=*&order=name.asc");
      return { foods };
    }
    if (path === "/api/foods" && options.method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const rows = await supabaseFetch("foods?on_conflict=name", {
        method: "POST",
        headers: { prefer: "resolution=merge-duplicates,return=representation" },
        body: JSON.stringify(body),
      });
      return { food: rows[0] };
    }
    if (path.startsWith("/api/entries") && (!options.method || options.method === "GET")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const from = params.get("from") || "1900-01-01";
      const to = params.get("to") || "2999-12-31";
      const entries = await supabaseFetch(`entries?eaten_on=gte.${encodeURIComponent(from)}&eaten_on=lte.${encodeURIComponent(to)}&select=*&order=eaten_on.asc,created_at.asc`);
      return { entries };
    }
    if (path === "/api/entries" && options.method === "POST") {
      const body = JSON.parse(options.body || "{}");
      const food = state.foods.find((item) => item.name === body.food_name);
      const payload = {
        eaten_on: body.eaten_on,
        meal: body.meal,
        food_name: body.food_name,
        amount: Number(body.amount),
        unit: body.unit || food?.unit || "g",
        kcal_per_100: Number(body.kcal_per_100 ?? food?.kcal_per_100),
        notes: body.notes || "",
      };
      const rows = await supabaseFetch("entries", { method: "POST", body: JSON.stringify(payload) });
      return { entry: rows[0] };
    }
    if (path.startsWith("/api/entries") && options.method === "DELETE") {
      const params = new URLSearchParams(path.split("?")[1] || "");
      const id = params.get("id");
      await supabaseFetch(`entries?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
      return { ok: true };
    }
    if (path.startsWith("/api/search-foods")) {
      const params = new URLSearchParams(path.split("?")[1] || "");
      return { results: await openFoodFactsSearch(params.get("q") || "") };
    }
  }

  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (token()) headers.authorization = `Bearer ${token()}`;
  const response = await fetch(path, { ...options, headers });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "요청 실패");
  return data;
}

function monthRange(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  const from = new Date(date.getFullYear(), date.getMonth(), 1);
  const to = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
}

function entriesForDate(date) {
  return state.entries.filter((entry) => entry.eaten_on === date);
}

function fmt(number) {
  return Math.round(Number(number || 0)).toLocaleString("ko-KR");
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderFoodOptions() {
  $("foodList").innerHTML = state.foods.map((food) => `<option value="${esc(food.name)}"></option>`).join("");
}

function renderSummary() {
  const dayEntries = entriesForDate(state.date);
  const total = dayEntries.reduce((sum, entry) => sum + Number(entry.estimated_kcal || 0), 0);
  $("dateTitle").textContent = state.date;
  $("totalKcal").textContent = `${fmt(total)} kcal`;
  $("goalDelta").textContent = `${total - goal > 0 ? "+" : ""}${fmt(total - goal)}`;
  $("entryCount").textContent = String(dayEntries.length);

  $("mealGrid").innerHTML = meals.map((meal) => {
    const items = dayEntries.filter((entry) => entry.meal === meal);
    const mealTotal = items.reduce((sum, entry) => sum + Number(entry.estimated_kcal || 0), 0);
    const rows = items.length ? items.map((entry) => `
      <li>
        <div>
          <strong>${esc(entry.food_name)}</strong>
          <small>${esc(entry.amount)}${esc(entry.unit)} · ${esc(entry.notes || "메모 없음")}</small>
        </div>
        <div>
          <b>${fmt(entry.estimated_kcal)}</b>
          <button class="delete" type="button" data-delete="${esc(entry.id)}">삭제</button>
        </div>
      </li>
    `).join("") : "<li><small>기록 없음</small></li>";
    return `
      <article class="meal-card">
        <header style="background:${mealColors[meal]}"><span>${esc(meal)}</span><span>${fmt(mealTotal)} kcal</span></header>
        <ul>${rows}</ul>
      </article>
    `;
  }).join("");
}

function renderCalendar() {
  const [from] = monthRange(state.date);
  const first = new Date(`${from}T00:00:00`);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const days = Array.from({ length: 35 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date.toISOString().slice(0, 10);
  });
  $("calendarGrid").innerHTML = days.map((date) => {
    const items = entriesForDate(date);
    const total = items.reduce((sum, entry) => sum + Number(entry.estimated_kcal || 0), 0);
    return `
      <div class="day-cell">
        <strong><span>${date.slice(5)}</span><span>${fmt(total)}</span></strong>
        <ol>${items.slice(0, 5).map((entry) => `<li>${esc(entry.meal)} ${esc(entry.food_name)} ${fmt(entry.estimated_kcal)}</li>`).join("")}</ol>
      </div>
    `;
  }).join("");
}

function renderFoods() {
  const headers = ["음식", "kcal/100", "단위", "분류", "메모"];
  const rows = state.foods.map((food) => [food.name, fmt(food.kcal_per_100), food.unit, food.category, food.notes || ""]);
  $("foodTable").innerHTML = [
    ...headers.map((header) => `<div class="head">${esc(header)}</div>`),
    ...rows.flatMap((row) => row.map((cell) => `<div>${esc(cell)}</div>`)),
  ].join("");
}

function renderSearchResults(results) {
  if (!results.length) {
    $("searchResults").innerHTML = "<small>검색 결과가 없습니다. 음식 DB 탭에서 직접 kcal 값을 추가해 주세요.</small>";
    return;
  }
  $("searchResults").innerHTML = results.map((item, index) => `
    <div class="search-result">
      <div>
        <strong>${esc(item.name)}</strong>
        <small>${esc(item.brand || item.source)} · ${fmt(item.kcal_per_100)} kcal / 100${esc(item.unit || "g")}</small>
      </div>
      <button type="button" data-add-search="${index}">DB 추가</button>
    </div>
  `).join("");
  state.searchResults = results;
}

function renderAll() {
  renderFoodOptions();
  renderSummary();
  renderCalendar();
  renderFoods();
}

async function load() {
  if (!supabaseSettings().url || !supabaseSettings().key) {
    setStatus("Supabase 연결값을 저장하면 데이터가 표시됩니다.");
    renderAll();
    return;
  }
  const [from, to] = monthRange(state.date);
  const [foods, entries] = await Promise.all([
    api("/api/foods"),
    api(`/api/entries?from=${from}&to=${to}`),
  ]);
  state.foods = foods.foods;
  state.entries = entries.entries;
  renderAll();
}

async function addEntry(event) {
  event.preventDefault();
  const food = state.foods.find((item) => item.name === $("foodName").value.trim());
  const payload = {
    eaten_on: state.date,
    meal: $("meal").value,
    food_name: $("foodName").value.trim(),
    amount: Number($("amount").value),
    unit: $("unit").value.trim() || food?.unit || "g",
    notes: $("notes").value.trim() || "조리 전 중량",
  };
  if (!payload.food_name || !payload.amount) return setStatus("음식과 분량을 입력해 주세요.", true);
  if (!food) return setStatus("Food DB에 없는 음식입니다. 먼저 음식 DB에 추가해 주세요.", true);
  await api("/api/entries", { method: "POST", body: JSON.stringify(payload) });
  $("entryForm").reset();
  $("unit").value = "g";
  setStatus("기록을 추가했습니다.");
  await load();
}

async function addFood(event) {
  event.preventDefault();
  const payload = {
    name: $("newFoodName").value.trim(),
    kcal_per_100: Number($("newFoodKcal").value),
    unit: $("newFoodUnit").value.trim() || "g",
    category: $("newFoodCategory").value.trim() || "기타",
  };
  if (!payload.name || !payload.kcal_per_100) return setStatus("음식명과 kcal 값을 입력해 주세요.", true);
  await api("/api/foods", { method: "POST", body: JSON.stringify(payload) });
  $("foodForm").reset();
  setStatus("Food DB를 저장했습니다.");
  await load();
}

async function searchFood() {
  const query = $("foodName").value.trim();
  if (query.length < 2) return setStatus("검색할 음식명을 2글자 이상 입력해 주세요.", true);
  setStatus("외부 DB에서 검색 중입니다.");
  const data = await api(`/api/search-foods?q=${encodeURIComponent(query)}`);
  renderSearchResults(data.results || []);
  setStatus(data.results?.length ? "검색 결과에서 DB에 추가할 항목을 선택하세요." : "검색 결과가 없습니다.");
}

async function addSearchResult(index) {
  const item = state.searchResults?.[Number(index)];
  if (!item) return;
  await api("/api/foods", {
    method: "POST",
    body: JSON.stringify({
      name: item.name,
      kcal_per_100: item.kcal_per_100,
      unit: item.unit || "g",
      category: item.category || "검색 결과",
      notes: item.source_url ? `${item.notes}; ${item.source_url}` : item.notes,
    }),
  });
  $("foodName").value = item.name;
  $("unit").value = item.unit || "g";
  $("searchResults").innerHTML = "";
  setStatus(`${item.name}을 Food DB에 추가했습니다.`);
  await load();
}

async function deleteEntry(id) {
  await api(`/api/entries?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  setStatus("기록을 삭제했습니다.");
  await load();
}

function bind() {
  $("activeDate").value = state.date;
  $("tokenInput").value = token();
  $("supabaseUrl").value = supabaseSettings().url;
  $("supabaseKey").value = supabaseSettings().key;
  $("activeDate").addEventListener("change", async (event) => {
    state.date = event.target.value;
    await load();
  });
  $("saveSettings").addEventListener("click", async () => {
    localStorage.setItem("calorieToken", $("tokenInput").value.trim());
    localStorage.setItem("supabaseUrl", $("supabaseUrl").value.trim());
    localStorage.setItem("supabaseKey", $("supabaseKey").value.trim());
    setStatus("설정을 저장했습니다.");
    await load();
  });
  $("foodName").addEventListener("change", () => {
    const food = state.foods.find((item) => item.name === $("foodName").value.trim());
    if (food) $("unit").value = food.unit;
  });
  $("entryForm").addEventListener("submit", (event) => addEntry(event).catch((error) => setStatus(error.message, true)));
  $("foodForm").addEventListener("submit", (event) => addFood(event).catch((error) => setStatus(error.message, true)));
  $("searchFood").addEventListener("click", () => searchFood().catch((error) => setStatus(error.message, true)));
  document.addEventListener("click", (event) => {
    const tab = event.target.closest(".tab");
    if (tab) {
      document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
      document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === tab.dataset.view));
    }
    const addSearchButton = event.target.closest("[data-add-search]");
    if (addSearchButton) addSearchResult(addSearchButton.dataset.addSearch).catch((error) => setStatus(error.message, true));
    const deleteButton = event.target.closest("[data-delete]");
    if (deleteButton) deleteEntry(deleteButton.dataset.delete).catch((error) => setStatus(error.message, true));
  });
}

bind();
load().catch((error) => setStatus(error.message, true));
