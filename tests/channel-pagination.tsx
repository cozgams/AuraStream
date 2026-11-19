import { createRoot } from "react-dom/client";
import { ChannelPage } from "../src/pages/Category";
import { AppProvider } from "../src/store";
import "../src/index.css";

const page1Ids = [12, 117, 2833, 323, 7628, 2181, 4466, 89, 5000, 903, 6000, 445, 123, 800, 701, 60, 1000, 3000, 20, 40];
const page2Ids = [3483, 131, 6174, 3273, 1237, 7000, 500, 9000, 52, 84, 600, 1200, 2500, 3300, 4100, 5200, 6600, 7100, 8100, 9100];

const makeVideo = (ids: number[]) => ids.map((id, index) => ({
  id,
  title: `Video ${id}`,
  cover: "",
  tags: [] as string[],
  score: (index * 13 + 5) % 101,
  hot: (index * 17 + 11) % 101,
  episode_count: 1,
  total_episodes: 1,
  is_finished: true,
  is_original: 0,
  like_count: 0,
  comment_count: 0,
  collect_count: 0,
}));

const page1 = makeVideo(page1Ids);
const page2 = makeVideo(page2Ids);
/* Simulated server-side sorting: latest by id desc, hot_window by hot desc, random pseudo-random. */
const sortList = (list: ReturnType<typeof makeVideo>, sort: string | undefined) => {
  const arr = [...list];
  if (sort === "hot_window") return arr.sort((a, b) => b.hot - a.hot);
  if (sort === "random") return arr.sort((a, b) => (a.id % 13) - (b.id % 13));
  return arr.sort((a, b) => b.id - a.id);
};
const pending: { args: Record<string, unknown>; resolve: (value: unknown) => void }[] = [];
const fixture = {
  history: [] as { cmd: string; args: Record<string, unknown> }[],
  pending,
  page1,
  page2,
  resolveNext(desiredSort?: string, desiredPage?: number) {
    const index = pending.findIndex(({ args }) =>
      (desiredSort === undefined || args.sort === desiredSort) && (desiredPage === undefined || args.page === desiredPage));
    const [request] = index < 0 ? [] : pending.splice(index, 1);
    if (!request) throw new Error(`no pending api_category request for sort=${desiredSort}, page=${desiredPage}`);
    const responsePage = Number(request.args.page);
    const responseSort = request.args.sort as string | undefined;
    const source = responsePage === 1 ? page1 : page2;
    request.resolve({
      items: sortList(source, responseSort),
      pagination: { page: responsePage, pages: 2, size: 20, total: 40 },
    });
  },
};

Object.assign(window, {
  channelPaginationFixture: fixture,
  __TAURI_INTERNALS__: {
    invoke(cmd: string, args: Record<string, unknown> = {}) {
      if (cmd === "app_boot") return Promise.resolve({ user: null, logged_in: false, base: "https://fixture.invalid" });
      if (cmd === "debug_log") return Promise.resolve();
      if (cmd === "api_category") {
        fixture.history.push({ cmd, args });
        return new Promise((resolve) => pending.push({ args, resolve }));
      }
      return Promise.reject(`Unexpected IPC: ${cmd}`);
    },
  },
});

// Dev StrictMode mounts effects twice, while production builds run without StrictMode.
// Keep single execution to maintain consistent pagination assertions.
createRoot(document.querySelector("#root")!).render(
  <AppProvider>
    <div style={{ position: "relative", width: 390, height: 844 }}>
      <ChannelPage cate="ai-duanju" name="AI Drama" onBack={() => {}} wide={false} />
    </div>
  </AppProvider>,
);
