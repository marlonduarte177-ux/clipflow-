import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bearer, closeTestApp, createTestApp, type TestContext } from "./test-helpers.js";

let ctx: TestContext | undefined;
beforeEach(async () => {
  ctx = await createTestApp();
});
afterEach(async () => {
  await closeTestApp(ctx);
  ctx = undefined;
});
const app = () => ctx!.app;

async function createProject(sub: string, body: object = { name: "Mi canal" }) {
  return app().inject({ method: "POST", url: "/projects", headers: bearer(sub), payload: body });
}

describe("proyectos", () => {
  it("exigen sesión", async () => {
    expect((await app().inject({ method: "GET", url: "/projects" })).statusCode).toBe(401);
    expect((await app().inject({ method: "POST", url: "/projects", payload: { name: "x" } })).statusCode).toBe(401);
  });

  it("crear, listar, ver, renombrar y borrar", async () => {
    const created = await createProject("alice", { name: "  Podcast  ", description: "Episodios" });
    expect(created.statusCode).toBe(201);
    const project = created.json();
    expect(project).toMatchObject({ name: "Podcast", description: "Episodios" });

    const list = await app().inject({ method: "GET", url: "/projects", headers: bearer("alice") });
    expect(list.json().projects).toHaveLength(1);

    const got = await app().inject({ method: "GET", url: `/projects/${project.id}`, headers: bearer("alice") });
    expect(got.json().id).toBe(project.id);

    const renamed = await app().inject({
      method: "PATCH",
      url: `/projects/${project.id}`,
      headers: bearer("alice"),
      payload: { name: "Podcast 2026" },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: "Podcast 2026", description: "Episodios" });

    const deleted = await app().inject({ method: "DELETE", url: `/projects/${project.id}`, headers: bearer("alice") });
    expect(deleted.statusCode).toBe(204);
    const after = await app().inject({ method: "GET", url: `/projects/${project.id}`, headers: bearer("alice") });
    expect(after.statusCode).toBe(404);
  });

  it("validan los datos", async () => {
    expect((await createProject("alice", { name: "   " })).statusCode).toBe(400);
    expect((await createProject("alice", { name: "x".repeat(121) })).statusCode).toBe(400);
    expect((await createProject("alice", {})).statusCode).toBe(400);
    const res = await createProject("alice", { name: 123 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("un id que no es UUID responde 404, no un error interno", async () => {
    const res = await app().inject({ method: "GET", url: "/projects/1%20or%201=1", headers: bearer("alice") });
    expect(res.statusCode).toBe(404);
  });
});

describe("aislamiento: un usuario no puede tocar proyectos de otro", () => {
  it("no aparecen en su lista", async () => {
    await createProject("alice");
    const list = await app().inject({ method: "GET", url: "/projects", headers: bearer("bob") });
    expect(list.json().projects).toEqual([]);
  });

  it("no puede verlos, editarlos ni borrarlos (responde 404 sin revelar que existen)", async () => {
    const project = (await createProject("alice")).json();
    const url = `/projects/${project.id}`;
    const asBob = bearer("bob");

    expect((await app().inject({ method: "GET", url, headers: asBob })).statusCode).toBe(404);
    expect(
      (await app().inject({ method: "PATCH", url, headers: asBob, payload: { name: "hackeado" } })).statusCode,
    ).toBe(404);
    expect((await app().inject({ method: "DELETE", url, headers: asBob })).statusCode).toBe(404);

    const still = await app().inject({ method: "GET", url, headers: bearer("alice") });
    expect(still.json().name).toBe("Mi canal");
  });

  it("no puede asignarse como dueño enviando userId en el cuerpo", async () => {
    const alice = (await app().inject({ method: "GET", url: "/me", headers: bearer("alice") })).json();
    const res = await createProject("bob", { name: "Truco", userId: alice.userId });
    expect(res.statusCode).toBe(201);
    const aliceList = await app().inject({ method: "GET", url: "/projects", headers: bearer("alice") });
    expect(aliceList.json().projects).toEqual([]);
  });
});
