CREATE TABLE IF NOT EXISTS dishly_goals (
  user_id VARCHAR(128) PRIMARY KEY,
  raw_text TEXT NOT NULL,
  parsed_filter JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS dishly_swipes (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  recipe_id VARCHAR(32) NOT NULL,
  direction VARCHAR(5) NOT NULL CHECK (direction IN ('left', 'right')),
  swiped_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  goal_updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dishly_swipes_user_id_id_idx
  ON dishly_swipes (user_id, id);

CREATE INDEX IF NOT EXISTS dishly_swipes_goal_version_idx
  ON dishly_swipes (user_id, goal_updated_at, id);
