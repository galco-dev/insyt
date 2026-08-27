-- Layer 6 (quality score / journey) findings were rejected by the original
-- 1..5 check, sinking every real run at the deliver stage.
alter table findings drop constraint if exists findings_layer_check;
alter table findings add constraint findings_layer_check check (layer >= 1 and layer <= 9);
