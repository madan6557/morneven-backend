#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BASE_URL = "https://backend.dev.morneven.com";
const DEFAULT_PASSWORD = "SeedPassword123";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Morneven development API QA runner

Usage:
  node qa/dev-api-qa.mjs [options]

Options:
  --base-url <url>              API base URL. Default: ${DEFAULT_BASE_URL}
  --scope <smoke|full>          Test scope. Default: smoke
  --run-id <id>                 QA run ID used in created records
  --allow-destructive           Allow delete cleanup for QA-owned records
  --include-global-state        Include map/settings update and rollback tests
  --include-file-upload         Include multipart file upload test
  --include-extraction          Include extraction job test. Requires QA_EXTRACTION_KEY or EXTRACTION_KEY
  --output-dir <path>           Report output directory. Default: qa/reports
  --help                        Show this help
`);
  process.exit(0);
}

const config = {
  baseUrl: normalizeBaseUrl(args.baseUrl ?? process.env.QA_BASE_URL ?? DEFAULT_BASE_URL),
  apiPrefix: process.env.QA_API_PREFIX ?? "/api",
  scope: args.scope ?? process.env.QA_SCOPE ?? "smoke",
  runId:
    args.runId ??
    process.env.QA_RUN_ID ??
    `QA-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${process.env.GITHUB_RUN_ID ?? "LOCAL"}`,
  allowDestructive:
    args.allowDestructive === true ||
    ["true", "1", "yes"].includes(String(process.env.QA_ALLOW_DESTRUCTIVE ?? "").toLowerCase()),
  includeGlobalState:
    args.includeGlobalState === true ||
    ["true", "1", "yes"].includes(String(process.env.QA_INCLUDE_GLOBAL_STATE ?? "").toLowerCase()),
  includeFileUpload:
    args.includeFileUpload === true ||
    ["true", "1", "yes"].includes(String(process.env.QA_INCLUDE_FILE_UPLOAD ?? "").toLowerCase()),
  includeExtraction:
    args.includeExtraction === true ||
    ["true", "1", "yes"].includes(String(process.env.QA_INCLUDE_EXTRACTION ?? "").toLowerCase()),
  extractionKey: process.env.QA_EXTRACTION_KEY ?? process.env.EXTRACTION_KEY ?? "",
  guestLoginMode: process.env.QA_GUEST_LOGIN_MODE ?? "endpoint",
  outputDir: args.outputDir ?? process.env.QA_OUTPUT_DIR ?? "qa/reports",
  accounts: {
    author: {
      email: process.env.QA_AUTHOR_EMAIL ?? "author@morneven.com",
      password: process.env.QA_AUTHOR_PASSWORD ?? process.env.QA_SEED_PASSWORD ?? DEFAULT_PASSWORD,
    },
    guest: {
      email: process.env.QA_GUEST_EMAIL ?? "guest@morneven.com",
      password: process.env.QA_GUEST_PASSWORD ?? process.env.QA_SEED_PASSWORD ?? DEFAULT_PASSWORD,
    },
    exec7: {
      email: process.env.QA_EXEC7_EMAIL ?? "author@morneven.com",
      password: process.env.QA_EXEC7_PASSWORD ?? process.env.QA_SEED_PASSWORD ?? DEFAULT_PASSWORD,
    },
    exec6: {
      email: process.env.QA_EXEC6_EMAIL ?? "v.kessler@morneven.com",
      password: process.env.QA_EXEC6_PASSWORD ?? process.env.QA_SEED_PASSWORD ?? DEFAULT_PASSWORD,
    },
    field5: {
      email: process.env.QA_FIELD5_EMAIL ?? "m.varga@morneven.com",
      password: process.env.QA_FIELD5_PASSWORD ?? process.env.QA_SEED_PASSWORD ?? DEFAULT_PASSWORD,
    },
  },
};

if (!["smoke", "full"].includes(config.scope)) {
  throw new Error(`Invalid QA scope: ${config.scope}`);
}

const state = {
  startedAt: new Date().toISOString(),
  records: [],
  tokens: {},
  users: {},
  created: [],
  warnings: [],
};

console.log(`Morneven API QA run: ${config.runId}`);
console.log(`Target: ${config.baseUrl}`);
console.log(`Scope: ${config.scope}`);

try {
  await runSmokeSuite();

  if (config.scope === "full") {
    await runFullSuite();
  }
} catch (error) {
  addRecord({
    suite: "Runner",
    name: "Unhandled runner error",
    method: "N/A",
    path: "N/A",
    expected: "Runner completes without unhandled errors",
    status: "FAIL",
    actual: errorToString(error),
  });
} finally {
  await writeReports();
}

const failed = state.records.filter((record) => record.status === "FAIL").length;
const blocked = state.records.filter((record) => record.status === "BLOCKED").length;

if (failed > 0 || blocked > 0) {
  process.exitCode = 1;
}

async function runSmokeSuite() {
  await requestTest({
    suite: "Smoke",
    name: "Root health endpoint",
    method: "GET",
    path: "/health",
    expectedStatuses: [200],
    validate: (body) => body?.success === true,
    expected: "200 and success true",
  });

  await requestTest({
    suite: "Smoke",
    name: "Root readiness endpoint",
    method: "GET",
    path: "/ready",
    expectedStatuses: [200],
    validate: (body) => body?.success === true,
    expected: "200 and success true",
  });

  await requestTest({
    suite: "Smoke",
    name: "API health endpoint",
    method: "GET",
    path: `${config.apiPrefix}/health`,
    expectedStatuses: [200],
    validate: (body) => body?.success === true,
    expected: "200 and success true",
  });

  await requestTest({
    suite: "Smoke",
    name: "API readiness endpoint",
    method: "GET",
    path: `${config.apiPrefix}/ready`,
    expectedStatuses: [200],
    validate: (body) => body?.success === true,
    expected: "200 and success true",
  });

  await requestTest({
    suite: "Auth",
    name: "Protected current user rejects missing token",
    method: "GET",
    path: `${config.apiPrefix}/auth/me`,
    expectedStatuses: [401],
    expected: "401 without Authorization header",
  });

  await login("author");

  await requestTest({
    suite: "Auth",
    name: "Current user accepts author token",
    method: "GET",
    path: `${config.apiPrefix}/auth/me`,
    token: state.tokens.author,
    expectedStatuses: [200],
    validate: (body) => body?.success === true,
    expected: "200 with authenticated user",
  });

  const authorToken = state.tokens.author;
  const smokeLists = [
    ["Projects list", `${config.apiPrefix}/projects?page=1&pageSize=5`],
    ["News list", `${config.apiPrefix}/news?page=1&pageSize=5`],
    ["Characters lore list", `${config.apiPrefix}/lore/characters?page=1&pageSize=5`],
    ["Gallery list", `${config.apiPrefix}/gallery?page=1&pageSize=5`],
    ["Chat conversations", `${config.apiPrefix}/chat/conversations`],
    ["Navigation badges", `${config.apiPrefix}/me/navigation-badges`],
    ["Notification unread count", `${config.apiPrefix}/notifications/unread-count`],
  ];

  for (const [name, pathName] of smokeLists) {
    await requestTest({
      suite: "Smoke",
      name,
      method: "GET",
      path: pathName,
      token: authorToken,
      expectedStatuses: [200],
      expected: "200 and no server error",
    });
  }

  const exec7LoggedIn = await login("exec7", { required: false });

  if (exec7LoggedIn) {
    await requestTest({
      suite: "Smoke",
      name: "Management pending count with PL7",
      method: "GET",
      path: `${config.apiPrefix}/management/requests/pending-count`,
      token: state.tokens.exec7,
      expectedStatuses: [200],
      expected: "200 for PL7 user",
    });
  } else {
    addBlocked(
      "Smoke",
      "Management pending count with PL7",
      "GET",
      `${config.apiPrefix}/management/requests/pending-count`,
      "PL7 login is required for this check.",
    );
  }
}

async function runFullSuite() {
  const guestLoggedIn = await login("guest", { required: false });
  const exec6LoggedIn = await login("exec6", { required: false });
  const fieldLoggedIn = await login("field5", { required: false });

  await requestTest({
    suite: "Auth",
    name: "Invalid login rejects wrong password",
    method: "POST",
    path: `${config.apiPrefix}/auth/login`,
    body: { email: config.accounts.author.email, password: "wrong-password" },
    expectedStatuses: [401],
    expected: "401 and no token",
  });

  if (guestLoggedIn) {
    await requestTest({
      suite: "RBAC",
      name: "Guest cannot access PL7 management pending count",
      method: "GET",
      path: `${config.apiPrefix}/management/requests/pending-count`,
      token: state.tokens.guest,
      expectedStatuses: [401, 403],
      expected: "401 or 403 for low privilege user",
    });
  } else {
    addBlocked("RBAC", "Guest cannot access PL7 management pending count", "GET", `${config.apiPrefix}/management/requests/pending-count`, "Guest login is unavailable.");
  }

  if (fieldLoggedIn) {
    await requestTest({
      suite: "RBAC",
      name: "Field user cannot run chat reconcile",
      method: "POST",
      path: `${config.apiPrefix}/chat/reconcile`,
      token: state.tokens.field5,
      expectedStatuses: [403],
      expected: "403 for PL6 non-executive or lower",
    });
  } else {
    addBlocked("RBAC", "Field user cannot run chat reconcile", "POST", `${config.apiPrefix}/chat/reconcile`, "Field account login is unavailable.");
  }

  if (exec6LoggedIn) {
    await requestTest({
      suite: "Chat",
      name: "PL6 executive cannot run chat reconcile maintenance",
      method: "POST",
      path: `${config.apiPrefix}/chat/reconcile`,
      token: state.tokens.exec6,
      expectedStatuses: [403],
      expected: "403 because chat reconcile is PL7 maintenance only",
    });
  } else {
    addBlocked("Chat", "PL6 executive cannot run chat reconcile maintenance", "POST", `${config.apiPrefix}/chat/reconcile`, "PL6 executive token is unavailable.");
  }

  if (state.tokens.exec7) {
    await requestTest({
      suite: "Chat",
      name: "PL7 maintenance user can run chat reconcile",
      method: "POST",
      path: `${config.apiPrefix}/chat/reconcile`,
      token: state.tokens.exec7,
      expectedStatuses: [200],
      expected: "200 for PL7 author, admin, or security maintenance user",
    });
  } else {
    addBlocked("Chat", "PL7 maintenance user can run chat reconcile", "POST", `${config.apiPrefix}/chat/reconcile`, "PL7 token is unavailable.");
  }

  await runReadOnlyFunctionalTests();
  await runContentCrudTests();
  await runGalleryDiscussionTests();
  await runChatFlowTests();
  await runManagementAndNotificationTests();

  if (config.includeGlobalState) {
    await runGlobalStateTests();
  } else {
    addSkip("Global state", "Map and command-center rollback tests skipped", "Set QA_INCLUDE_GLOBAL_STATE=true to include them.");
  }

  if (config.includeFileUpload) {
    await runFileUploadTest();
  } else {
    addSkip("Files", "File upload skipped", "Set QA_INCLUDE_FILE_UPLOAD=true to include it.");
  }

  if (config.includeExtraction) {
    await runExtractionTest();
  } else {
    addSkip("Extraction", "Extraction job skipped", "Set QA_INCLUDE_EXTRACTION=true to include it.");
  }
}

async function runReadOnlyFunctionalTests() {
  const token = state.tokens.author;
  const readOnlyCases = [
    ["Project by seed ID", `${config.apiPrefix}/projects/proj-001`],
    ["News by unknown ID returns 404", `${config.apiPrefix}/news/unknown-${config.runId}`, [404]],
    ["Lore seed character", `${config.apiPrefix}/lore/characters/char-001`],
    ["Invalid lore category", `${config.apiPrefix}/lore/invalid-category`, [400, 404]],
    ["Gallery seed item", `${config.apiPrefix}/gallery/gal-001`],
    ["Personnel list", `${config.apiPrefix}/personnel?page=1&pageSize=5`],
    ["Management teams list", `${config.apiPrefix}/management/teams`],
    ["Management requests list", `${config.apiPrefix}/management/requests`],
  ];

  for (const [name, pathName, statuses = [200]] of readOnlyCases) {
    await requestTest({
      suite: "Read-only functional",
      name,
      method: "GET",
      path: pathName,
      token,
      expectedStatuses: statuses,
      expected: `${statuses.join(" or ")} expected`,
    });
  }
}

async function runContentCrudTests() {
  const token = state.tokens.author;

  const project = await requestTest({
    suite: "Projects",
    name: "Create QA project",
    method: "POST",
    path: `${config.apiPrefix}/projects`,
    token,
    body: {
      title: `${config.runId} Project`,
      status: "Planning",
      thumbnail: "https://example.com/project.png",
      shortDesc: "QA project short description",
      fullDesc: "QA project full description.",
      patches: [{ version: "0.1.0", date: new Date().toISOString().slice(0, 10), notes: "QA patch note" }],
      docs: [],
      archived: false,
      contributor: "author",
      meta: { qaRun: config.runId },
    },
    expectedStatuses: [200, 201],
    expected: "Project is created",
  });
  const projectId = extractId(project.body);
  rememberCreated("Project", projectId, `${config.apiPrefix}/projects/${projectId}`, token);
  if (projectId) {
    await requestTest({
      suite: "Projects",
      name: "Update QA project",
      method: "PUT",
      path: `${config.apiPrefix}/projects/${projectId}`,
      token,
      body: {
        title: `${config.runId} Project Updated`,
        status: "On Progress",
        thumbnail: "https://example.com/project.png",
        shortDesc: "QA project short description updated",
        fullDesc: "QA project full description updated.",
        patches: [],
        docs: [],
        archived: false,
        contributor: "author",
        meta: { qaRun: config.runId },
      },
      expectedStatuses: [200],
      expected: "Project is updated",
    });
    await cleanupOne("Project", projectId, `${config.apiPrefix}/projects/${projectId}`, token);
  }

  const news = await requestTest({
    suite: "News",
    name: "Create QA news",
    method: "POST",
    path: `${config.apiPrefix}/news`,
    token,
    body: {
      text: `${config.runId} news headline`,
      hasDetail: true,
      thumbnail: "https://example.com/news.png",
      body: "QA full news body",
      publishDate: new Date().toISOString(),
      attachments: [],
    },
    expectedStatuses: [200, 201],
    expected: "News is created",
  });
  const newsId = extractId(news.body);
  rememberCreated("News", newsId, `${config.apiPrefix}/news/${newsId}`, token);
  if (newsId) {
    await requestTest({
      suite: "News",
      name: "Update QA news",
      method: "PUT",
      path: `${config.apiPrefix}/news/${newsId}`,
      token,
      body: {
        text: `${config.runId} news headline updated`,
        hasDetail: true,
        thumbnail: "https://example.com/news.png",
        body: "QA full news body updated",
        publishDate: new Date().toISOString(),
        attachments: [],
      },
      expectedStatuses: [200],
      expected: "News is updated",
    });
    await cleanupOne("News", newsId, `${config.apiPrefix}/news/${newsId}`, token);
  }

  const lore = await requestTest({
    suite: "Lore",
    name: "Create QA character lore",
    method: "POST",
    path: `${config.apiPrefix}/lore/characters`,
    token,
    body: {
      name: `${config.runId} Character`,
      shortDesc: "QA character short description",
      fullDesc: "QA character full description.",
      image: "https://example.com/character.png",
      docs: [],
      metadata: { qaRun: config.runId },
    },
    expectedStatuses: [200, 201],
    expected: "Lore item is created",
  });
  const loreId = extractId(lore.body);
  rememberCreated("Lore character", loreId, `${config.apiPrefix}/lore/characters/${loreId}`, token);
  if (loreId) {
    await requestTest({
      suite: "Lore",
      name: "Update QA character lore",
      method: "PUT",
      path: `${config.apiPrefix}/lore/characters/${loreId}`,
      token,
      body: {
        name: `${config.runId} Character Updated`,
        shortDesc: "QA character short description updated",
        fullDesc: "QA character full description updated.",
        image: "https://example.com/character.png",
        docs: [],
        metadata: { qaRun: config.runId },
      },
      expectedStatuses: [200],
      expected: "Lore item is updated",
    });
    await cleanupOne("Lore character", loreId, `${config.apiPrefix}/lore/characters/${loreId}`, token);
  }
}

async function runGalleryDiscussionTests() {
  const token = state.tokens.author;
  const gallery = await requestTest({
    suite: "Gallery",
    name: "Create QA gallery item",
    method: "POST",
    path: `${config.apiPrefix}/gallery`,
    token,
    body: {
      type: "image",
      title: `${config.runId} Gallery Item`,
      thumbnail: "https://example.com/gallery.png",
      videoUrl: "",
      caption: "QA gallery caption",
      tags: ["qa", config.runId],
      date: new Date().toISOString().slice(0, 10),
      uploadedBy: "author",
    },
    expectedStatuses: [200, 201],
    expected: "Gallery item is created",
  });
  const galleryId = extractId(gallery.body);
  rememberCreated("Gallery item", galleryId, `${config.apiPrefix}/gallery/${galleryId}`, token);

  if (!galleryId) return;

  await requestTest({
    suite: "Gallery",
    name: "Update QA gallery item",
    method: "PUT",
    path: `${config.apiPrefix}/gallery/${galleryId}`,
    token,
    body: {
      type: "image",
      title: `${config.runId} Gallery Item Updated`,
      thumbnail: "https://example.com/gallery.png",
      videoUrl: "",
      caption: "QA gallery caption updated",
      tags: ["qa", config.runId],
      date: new Date().toISOString().slice(0, 10),
      uploadedBy: "author",
    },
    expectedStatuses: [200],
    expected: "Gallery item is updated",
  });

  const comment = await requestTest({
    suite: "Gallery discussions",
    name: "Create gallery comment",
    method: "POST",
    path: `${config.apiPrefix}/gallery/${galleryId}/comments`,
    token,
    body: { text: `${config.runId} gallery comment` },
    expectedStatuses: [200, 201],
    expected: "Comment is created",
  });
  const commentId = extractId(comment.body);

  let replyId = null;
  if (commentId) {
    const reply = await requestTest({
      suite: "Gallery discussions",
      name: "Create gallery reply",
      method: "POST",
      path: `${config.apiPrefix}/gallery/${galleryId}/comments/${commentId}/replies`,
      token,
      body: { text: `${config.runId} gallery reply` },
      expectedStatuses: [200, 201],
      expected: "Reply is created",
    });
    replyId = extractId(reply.body);
  }

  if (replyId) {
    await cleanupOne(
      "Gallery reply",
      replyId,
      `${config.apiPrefix}/gallery/${galleryId}/comments/${commentId}/replies/${replyId}`,
      token,
    );
  }
  if (commentId) {
    await cleanupOne("Gallery comment", commentId, `${config.apiPrefix}/gallery/${galleryId}/comments/${commentId}`, token);
  }
  await cleanupOne("Gallery item", galleryId, `${config.apiPrefix}/gallery/${galleryId}`, token);
}

async function runChatFlowTests() {
  const token = state.tokens.author;
  const message = await requestTest({
    suite: "Chat",
    name: "Send message to institute conversation",
    method: "POST",
    path: `${config.apiPrefix}/chat/messages`,
    token,
    body: {
      conversationId: "conv-institute",
      text: `${config.runId} message test`,
      attachments: [],
    },
    expectedStatuses: [200, 201],
    expected: "Message is created",
  });
  const messageId = extractId(message.body);
  if (messageId) {
    await cleanupOne("Chat message", messageId, `${config.apiPrefix}/chat/messages/${messageId}`, token);
  }

  await requestTest({
    suite: "Chat",
    name: "Reject empty message",
    method: "POST",
    path: `${config.apiPrefix}/chat/messages`,
    token,
    body: {
      conversationId: "conv-institute",
      text: "",
      attachments: [],
    },
    expectedStatuses: [400, 422],
    expected: "Validation error for empty text and attachments",
  });

  await requestTest({
    suite: "Chat",
    name: "Create DM with m.varga",
    method: "POST",
    path: `${config.apiPrefix}/chat/dm`,
    token,
    body: { username: "m.varga" },
    expectedStatuses: [200, 201],
    expected: "DM is returned or created",
  });

  const group = await requestTest({
    suite: "Chat",
    name: "Create manual QA group",
    method: "POST",
    path: `${config.apiPrefix}/chat/groups`,
    token,
    body: {
      name: `${config.runId} Group`,
      invitees: ["m.varga", "s.okafor"],
    },
    expectedStatuses: [200, 201],
    expected: "Manual group is created",
  });
  const groupId = extractId(group.body);
  if (groupId) {
    addRecord({
      suite: "Cleanup",
      name: "Manual group cleanup note",
      method: "N/A",
      path: `${config.apiPrefix}/chat/conversations/${groupId}`,
      expected: "No hard-delete endpoint exists",
      status: "SKIP",
      actual: "Manual group left behind with QA prefix.",
    });
  }
}

async function runManagementAndNotificationTests() {
  const execToken = state.tokens.exec7;
  const authorToken = state.tokens.author;

  if (!execToken) {
    addBlocked(
      "Management",
      "Management and notification privileged workflow",
      "N/A",
      "N/A",
      "PL7 token is unavailable.",
    );
    return;
  }

  const request = await requestTest({
    suite: "Management",
    name: "Create QA management request",
    method: "POST",
    path: `${config.apiPrefix}/management/requests`,
    token: authorToken,
    body: {
      kind: "executive_promotion",
      payload: {
        username: "t.bremmer",
        targetLevel: 6,
      },
      reason: `${config.runId} executive promotion`,
    },
    expectedStatuses: [200, 201],
    expected: "Management request is created",
  });
  const requestId = extractId(request.body);
  if (requestId) {
    addRecord({
      suite: "Cleanup",
      name: "Management request cleanup note",
      method: "N/A",
      path: `${config.apiPrefix}/management/requests/${requestId}`,
      expected: "No hard-delete endpoint exists",
      status: "SKIP",
      actual: "Management request left behind or decided by workflow.",
    });
  }

  const notification = await requestTest({
    suite: "Notifications",
    name: "Create QA notification",
    method: "POST",
    path: `${config.apiPrefix}/notifications`,
    token: execToken,
    body: {
      kind: "info",
      title: `${config.runId} Notification`,
      body: "QA notification body",
      recipient: "author",
      sender: "author",
      link: "/command-center",
    },
    expectedStatuses: [200, 201],
    expected: "Notification is created by PL7",
  });
  const notificationId = extractId(notification.body);
  if (notificationId) {
    await requestTest({
      suite: "Notifications",
      name: "Mark QA notification read",
      method: "POST",
      path: `${config.apiPrefix}/notifications/${notificationId}/read`,
      token: authorToken,
      expectedStatuses: [200],
      expected: "Notification is marked read by recipient",
    });
    await cleanupOne("Notification", notificationId, `${config.apiPrefix}/notifications/${notificationId}`, authorToken);
  }
}

async function runGlobalStateTests() {
  const token = state.tokens.exec7;

  if (!token) {
    addBlocked("Global state", "Global-state tests", "N/A", "N/A", "PL7 token is unavailable.");
    return;
  }

  const markers = await requestTest({
    suite: "Global state",
    name: "Backup current map markers",
    method: "GET",
    path: `${config.apiPrefix}/map/markers`,
    token,
    expectedStatuses: [200],
    expected: "Current markers can be read before update",
  });
  const originalMarkers = extractData(markers.body)?.markers ?? extractData(markers.body) ?? [];

  await requestTest({
    suite: "Global state",
    name: "Update map markers with QA marker",
    method: "PUT",
    path: `${config.apiPrefix}/map/markers`,
    token,
    body: {
      markers: [
        ...(Array.isArray(originalMarkers) ? originalMarkers : []),
        {
          id: `qa-marker-${config.runId.toLowerCase()}`,
          name: `${config.runId} Marker`,
          status: "safe",
          x: 0.35,
          y: 0.45,
          description: "QA map marker",
          loreLink: "place-001",
        },
      ],
    },
    expectedStatuses: [200],
    expected: "Map markers are updated",
  });

  await requestTest({
    suite: "Global state",
    name: "Rollback map markers",
    method: "PUT",
    path: `${config.apiPrefix}/map/markers`,
    token,
    body: { markers: Array.isArray(originalMarkers) ? originalMarkers : [] },
    expectedStatuses: [200],
    expected: "Original markers are restored",
  });
}

async function runFileUploadTest() {
  const token = state.tokens.author;
  const form = new FormData();
  form.append("file", new Blob(["morneven qa upload\n"], { type: "text/plain" }), `${config.runId}.txt`);

  await requestTest({
    suite: "Files",
    name: "Upload small QA file",
    method: "POST",
    path: `${config.apiPrefix}/files/upload?folder=uploads`,
    token,
    body: form,
    expectedStatuses: [200, 201],
    expected: "Small file is uploaded",
  });

  addRecord({
    suite: "Cleanup",
    name: "Uploaded file cleanup note",
    method: "N/A",
    path: `${config.apiPrefix}/files/upload`,
    expected: "No confirmed delete endpoint exists",
    status: "SKIP",
    actual: "Uploaded file may require storage cleanup outside API.",
  });
}

async function runExtractionTest() {
  if (!state.tokens.exec7) {
    addBlocked("Extraction", "Start DB extraction job", "POST", `${config.apiPrefix}/settings/extractions`, "PL7 token is unavailable.");
    return;
  }
  if (!config.extractionKey) {
    addBlocked("Extraction", "Start DB extraction job", "POST", `${config.apiPrefix}/settings/extractions`, "Set QA_EXTRACTION_KEY or EXTRACTION_KEY before enabling extraction QA.");
    return;
  }

  await requestTest({
    suite: "Extraction",
    name: "Start DB extraction job",
    method: "POST",
    path: `${config.apiPrefix}/settings/extractions`,
    token: state.tokens.exec7,
    body: {
      mode: "db",
      autoDownload: false,
      confirmText: "CONFIRM",
      password: config.accounts.exec7.password,
      secretKey: config.extractionKey,
    },
    expectedStatuses: [200, 201, 202],
    expected: "Extraction job is accepted",
  });
}

async function login(accountName, options = {}) {
  const required = options.required ?? true;
  if (state.tokens[accountName]) return true;

  if (accountName === "guest" && config.guestLoginMode !== "credentials") {
    const result = await requestTest({
      suite: "Auth",
      name: "Login as guest via guest endpoint",
      method: "POST",
      path: `${config.apiPrefix}/auth/guest`,
      expectedStatuses: [200],
      validate: (body) => Boolean(extractToken(body)),
      expected: "200 and guest access token returned",
    });

    const token = extractToken(result.body);
    if (!token) {
      if (!required) return false;
      throw new Error("Guest endpoint did not return a token");
    }
    state.tokens[accountName] = token;
    state.users[accountName] = extractData(result.body)?.user ?? result.body?.user ?? null;
    return true;
  }

  const account = config.accounts[accountName];
  const result = await requestTest({
    suite: "Auth",
    name: `Login as ${accountName}`,
    method: "POST",
    path: `${config.apiPrefix}/auth/login`,
    body: { email: account.email, password: account.password },
    expectedStatuses: [200],
    validate: (body) => Boolean(extractToken(body)),
    expected: "200 and access token returned",
  });

  const token = extractToken(result.body);
  if (!token) {
    if (!required) {
      return false;
    }
    throw new Error(`Login did not return a token for ${accountName}`);
  }
  state.tokens[accountName] = token;
  state.users[accountName] = extractData(result.body)?.user ?? result.body?.user ?? null;
  return true;
}

async function requestTest({ suite, name, method, path: pathName, token, body, expectedStatuses, validate, expected }) {
  const started = Date.now();
  const url = new URL(pathName, config.baseUrl).toString();
  const headers = {};

  if (token) headers.Authorization = `Bearer ${token}`;
  const init = { method, headers };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
  }

  try {
    const response = await fetch(url, init);
    const responseText = await response.text();
    const parsed = parseJsonSafe(responseText);
    const statusOk = expectedStatuses.includes(response.status);
    const predicateOk = validate ? Boolean(validate(parsed, response)) : true;
    const passed = statusOk && predicateOk;
    const actual = summarizeResponse(response.status, parsed, responseText);

    addRecord({
      suite,
      name,
      method,
      path: pathName,
      expected,
      status: passed ? "PASS" : "FAIL",
      httpStatus: response.status,
      durationMs: Date.now() - started,
      actual,
      response: parsed ?? responseText,
    });

    return { response, body: parsed, text: responseText };
  } catch (error) {
    addRecord({
      suite,
      name,
      method,
      path: pathName,
      expected,
      status: "BLOCKED",
      durationMs: Date.now() - started,
      actual: errorToString(error),
    });
    return { response: null, body: null, text: "" };
  }
}

async function cleanupOne(entity, id, pathName, token) {
  if (!id) return;
  if (!config.allowDestructive) {
    addRecord({
      suite: "Cleanup",
      name: `Cleanup skipped for ${entity}`,
      method: "DELETE",
      path: pathName,
      expected: "Destructive cleanup disabled",
      status: "SKIP",
      actual: "Set QA_ALLOW_DESTRUCTIVE=true to delete QA-owned records.",
    });
    return;
  }

  await requestTest({
    suite: "Cleanup",
    name: `Delete QA ${entity}`,
    method: "DELETE",
    path: pathName,
    token,
    expectedStatuses: [200, 202, 204],
    expected: "QA-owned record is deleted",
  });
}

function rememberCreated(entity, id, pathName, token) {
  if (!id) return;
  state.created.push({ entity, id, path: pathName, tokenPresent: Boolean(token) });
}

function addSkip(suite, name, actual) {
  addRecord({
    suite,
    name,
    method: "N/A",
    path: "N/A",
    expected: "Optional test is not enabled",
    status: "SKIP",
    actual,
  });
}

function addBlocked(suite, name, method, pathName, actual) {
  addRecord({
    suite,
    name,
    method,
    path: pathName,
    expected: "Prerequisite is available",
    status: "BLOCKED",
    actual,
  });
}

function addRecord(record) {
  state.records.push({
    timestamp: new Date().toISOString(),
    ...record,
  });
  const marker =
    record.status === "PASS" ? "PASS" : record.status === "SKIP" ? "SKIP" : record.status === "BLOCKED" ? "BLOCKED" : "FAIL";
  console.log(`[${marker}] ${record.suite} - ${record.name}`);
}

async function writeReports() {
  const endedAt = new Date().toISOString();
  const summary = {
    runId: config.runId,
    startedAt: state.startedAt,
    endedAt,
    baseUrl: config.baseUrl,
    apiPrefix: config.apiPrefix,
    scope: config.scope,
    allowDestructive: config.allowDestructive,
    includeGlobalState: config.includeGlobalState,
    includeFileUpload: config.includeFileUpload,
    includeExtraction: config.includeExtraction,
    totals: countTotals(state.records),
    created: state.created,
  };

  await mkdir(config.outputDir, { recursive: true });
  const safeRunId = config.runId.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const jsonPath = path.join(config.outputDir, `dev-api-qa-${safeRunId}.json`);
  const mdPath = path.join(config.outputDir, `dev-api-qa-${safeRunId}.md`);

  await writeFile(jsonPath, JSON.stringify({ summary, records: state.records }, null, 2));
  await writeFile(mdPath, renderMarkdown(summary, state.records));

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, renderMarkdown(summary, state.records));
  }

  console.log(`JSON report: ${jsonPath}`);
  console.log(`Markdown report: ${mdPath}`);
}

function renderMarkdown(summary, records) {
  const lines = [
    "# Morneven Development API QA Report",
    "",
    "## Summary",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Run ID | \`${summary.runId}\` |`,
    `| Started | ${summary.startedAt} |`,
    `| Ended | ${summary.endedAt} |`,
    `| Base URL | \`${summary.baseUrl}\` |`,
    `| API prefix | \`${summary.apiPrefix}\` |`,
    `| Scope | \`${summary.scope}\` |`,
    `| Destructive cleanup | \`${summary.allowDestructive}\` |`,
    `| Global-state tests | \`${summary.includeGlobalState}\` |`,
    `| File upload tests | \`${summary.includeFileUpload}\` |`,
    `| Extraction tests | \`${summary.includeExtraction}\` |`,
    "",
    "## Totals",
    "",
    "| Status | Count |",
    "| --- | ---: |",
    `| PASS | ${summary.totals.PASS ?? 0} |`,
    `| FAIL | ${summary.totals.FAIL ?? 0} |`,
    `| BLOCKED | ${summary.totals.BLOCKED ?? 0} |`,
    `| SKIP | ${summary.totals.SKIP ?? 0} |`,
    "",
    "## Results",
    "",
    "| Status | Suite | Test | Method | Path | HTTP | Expected | Actual |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- |",
  ];

  for (const record of records) {
    lines.push(
      `| ${record.status} | ${escapeMd(record.suite)} | ${escapeMd(record.name)} | \`${record.method}\` | \`${record.path}\` | ${
        record.httpStatus ?? ""
      } | ${escapeMd(record.expected ?? "")} | ${escapeMd(record.actual ?? "")} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function countTotals(records) {
  return records.reduce((totals, record) => {
    totals[record.status] = (totals[record.status] ?? 0) + 1;
    return totals;
  }, {});
}

function extractToken(body) {
  return (
    body?.data?.accessToken ??
    body?.data?.token ??
    body?.accessToken ??
    body?.token ??
    body?.data?.tokens?.accessToken ??
    null
  );
}

function extractId(body) {
  const data = extractData(body);
  return (
    data?.id ??
    data?._id ??
    data?.item?.id ??
    data?.record?.id ??
    data?.project?.id ??
    data?.news?.id ??
    data?.lore?.id ??
    data?.gallery?.id ??
    data?.comment?.id ??
    data?.reply?.id ??
    data?.message?.id ??
    data?.conversation?.id ??
    data?.notification?.id ??
    data?.request?.id ??
    body?.id ??
    null
  );
}

function extractData(body) {
  return body?.data ?? body;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") parsed.help = true;
    else if (arg === "--allow-destructive") parsed.allowDestructive = true;
    else if (arg === "--include-global-state") parsed.includeGlobalState = true;
    else if (arg === "--include-file-upload") parsed.includeFileUpload = true;
    else if (arg === "--include-extraction") parsed.includeExtraction = true;
    else if (arg === "--base-url") parsed.baseUrl = argv[++index];
    else if (arg === "--scope") parsed.scope = argv[++index];
    else if (arg === "--run-id") parsed.runId = argv[++index];
    else if (arg === "--output-dir") parsed.outputDir = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function parseJsonSafe(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function summarizeResponse(status, parsed, text) {
  const message = parsed?.message ? ` message=${parsed.message}` : "";
  const errorCode = parsed?.errorCode ? ` errorCode=${parsed.errorCode}` : "";
  const body = parsed ? "" : ` body=${String(text).slice(0, 160)}`;
  return `HTTP ${status}${message}${errorCode}${body}`;
}

function errorToString(error) {
  return error?.stack ?? error?.message ?? String(error);
}

function escapeMd(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ").slice(0, 400);
}
