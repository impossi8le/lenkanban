-- Existing requests retain the general responsible-group queue. No data reset.
ALTER TABLE "TaskRequest" ADD COLUMN "audienceUserIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "TaskRequest" ADD CONSTRAINT "TaskRequest_audience_shape_check" CHECK (
  cardinality("audienceUserIds") BETWEEN 0 AND 20
  AND COALESCE(array_ndims("audienceUserIds"), 1) = 1
  AND array_position("audienceUserIds", NULL) IS NULL
);
-- IDs, uniqueness and current responsible-group eligibility are checked by the
-- canonical creation transaction. Audience is not an editable command field.
