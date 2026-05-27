import type { Cut, ProjectState, ProjectSummary, RenderSettings } from "./types";

const API = "/api";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export const api = {
  listProjects: () =>
    jsonFetch<{ projects: ProjectSummary[] }>("/projects").then((r) => r.projects),

  getProject: (id: string) => jsonFetch<ProjectState>(`/projects/${id}`),

  saveCuts: (id: string, cuts: Cut[]) =>
    jsonFetch<{ ok: boolean; count: number }>(`/projects/${id}/cuts`, {
      method: "POST",
      body: JSON.stringify(cuts),
    }),

  render: (id: string, settings?: RenderSettings) =>
    jsonFetch<{ ok: boolean; output: string; size: number }>(`/projects/${id}/render`, {
      method: "POST",
      body: settings ? JSON.stringify(settings) : undefined,
    }),

  revealOutput: (id: string) =>
    jsonFetch<{ ok: boolean; path: string }>(`/projects/${id}/reveal`, { method: "POST" }),

  cancelRender: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/projects/${id}/cancel-render`, { method: "POST" }),

  deleteProject: (id: string) =>
    jsonFetch<{ ok: boolean }>(`/projects/${id}`, { method: "DELETE" }),

  importFile: async (file: File, onProgress?: (frac: number) => void) => {
    // Use XHR so we can report upload progress to the UI.
    return new Promise<{ id: string; size: number; status: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const form = new FormData();
      form.append("file", file);
      xhr.open("POST", `${API}/projects/import`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error(`${xhr.status} ${xhr.statusText}: ${xhr.responseText}`));
        }
      };
      xhr.onerror = () => reject(new Error("upload failed"));
      xhr.send(form);
    });
  },

  sourceUrl: (id: string) => `${API}/projects/${id}/source.mp4`,
  outputUrl: (id: string) => `${API}/projects/${id}/output.mp4`,
};
