import { Router } from "express";
import { requireAuth, AuthRequest } from "../auth.ts";
import { getDb, toId, docsWithId } from "../db.ts";
import { log } from "../logger.ts";

export function createMappingsRouter() {
  const router = Router();

  // =====================================
  // CRUD: Mappings
  // =====================================
  router.get("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    const docs = await db.collection('mappings').find({ playlistId: playlistId as string }).toArray();
    res.json(docsWithId(docs));
  });

  router.post("/mappings", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const result = await db.collection('mappings').insertOne(req.body);
    res.status(201).json({ id: result.insertedId.toString(), ...req.body });
  });

  router.put("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id, ...update } = req.body;
    await db.collection('mappings').updateOne({ _id: toId(req.params.id) }, { $set: update });
    res.json({ success: true });
  });

  router.post("/mappings/batch", requireAuth, async (req: AuthRequest, res) => {
    try {
      const db = getDb();
      const { updates } = req.body; // Array of { id?, originalId, playlistId, type, ...data }

      const ops = updates.map((update: any) => {
        const { id, ...data } = update;
        // Use id-based update only when id is a valid 24-char hex ObjectId string;
        // fall back to upsert-by-naturalKey otherwise to avoid throwing on bad IDs.
        const isValidId = id && /^[a-f\d]{24}$/i.test(id);
        if (isValidId) {
          return {
            updateOne: {
              filter: { _id: toId(id) },
              update: { $set: data }
            }
          };
        } else {
          return {
            updateOne: {
              filter: { originalId: data.originalId, playlistId: data.playlistId, type: data.type },
              update: { $set: data },
              upsert: true
            }
          };
        }
      });

      if (ops.length > 0) {
        await db.collection('mappings').bulkWrite(ops, { ordered: false });
      }
      res.json({ success: true, count: ops.length });
    } catch (err: any) {
      log(`[batch mappings] error: ${err?.message || err}`);
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  router.delete("/mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    await db.collection('mappings').deleteOne({ _id: toId(req.params.id) });
    res.json({ success: true });
  });

  // =====================================
  // CRUD: Category Mappings
  // =====================================
  router.get("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const { playlistId } = req.query;
    if (!playlistId) return res.status(400).json({ error: "playlistId required" });
    const db = getDb();
    const docs = await db.collection('categoryMappings').find({ playlistId: playlistId as string }).toArray();
    res.json(docsWithId(docs));
  });

  router.post("/category-mappings", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const result = await db.collection('categoryMappings').insertOne(req.body);
    res.status(201).json({ id: result.insertedId.toString(), ...req.body });
  });

  router.put("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { id, ...update } = req.body;
    await db.collection('categoryMappings').updateOne({ _id: toId(req.params.id) }, { $set: update });
    res.json({ success: true });
  });

  router.post("/category-mappings/batch", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    const { updates } = req.body;

    const ops = updates.map((update: any) => {
      const { id, ...data } = update;
      if (id) {
        return {
          updateOne: {
            filter: { _id: toId(id) },
            update: { $set: data }
          }
        };
      } else {
        return {
          updateOne: {
            filter: { originalId: data.originalId, playlistId: data.playlistId, type: data.type },
            update: { $set: data },
            upsert: true
          }
        };
      }
    });

    if (ops.length > 0) {
      await db.collection('categoryMappings').bulkWrite(ops);
    }
    res.json({ success: true, count: ops.length });
  });

  router.delete("/category-mappings/:id", requireAuth, async (req: AuthRequest, res) => {
    const db = getDb();
    await db.collection('categoryMappings').deleteOne({ _id: toId(req.params.id) });
    res.json({ success: true });
  });

  return router;
}
