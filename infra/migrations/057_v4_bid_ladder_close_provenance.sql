ALTER TABLE v4_bid_ladders
ADD COLUMN close_provenance TEXT
CHECK (
  close_provenance IS NULL OR
  close_provenance IN ('FUNI_EXECUTED','EXTERNAL_OPERATOR_CLOSE','UNKNOWN_EXTERNAL')
);
