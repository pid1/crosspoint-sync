-- Optional multi-identifier document matching, tracking
-- koreader/koreader-sync-server#55 (open, unmerged). A client offers several
-- digests for one book - content, structure, metadata - so a recompressed or
-- re-downloaded copy keeps its position. Identifiers other than the record's
-- own digest become aliases for it.
--
-- Separate from `document_aliases`: that table records a merge the user asked
-- for and every request follows it, while these are followed only by a request
-- that names identifiers. A client that names none reads exactly what it always
-- read.
CREATE TABLE identifier_aliases (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  alias      TEXT NOT NULL,   -- an offered value that is not itself a document
  id_type    TEXT NOT NULL,   -- the client's own label, stored and echoed uninterpreted
  document   TEXT NOT NULL,   -- the canonical document it resolves to
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, alias)
);
CREATE INDEX idx_identifier_aliases_doc ON identifier_aliases(user_id, document);

-- The identifiers held by the client that wrote this row's `progress`, written
-- with it on every push. A push naming none clears them, so an earlier client's
-- claims stop being attributed to a position string it did not write.
ALTER TABLE progress ADD COLUMN identifiers TEXT;
