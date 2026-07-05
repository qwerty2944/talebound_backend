-- inventory_add_item / inventory_remove_item 가 존재하지 않는 컬럼 profile_id 로
-- inventories 를 조회해 항상 inventory_not_found(실제로는 SQL 에러)로 실패하던 버그 수정.
-- inventory_get 과 동일하게 user_id -> characters.id(character_id) 로 해석한 뒤
-- inventories.character_id 로 조회하도록 교정한다.
-- (기존엔 quest 보상 아이템 지급/collect 차감이 조용히 실패, 신규 shop buy/sell 도 동일 경로 사용)

CREATE OR REPLACE FUNCTION public.inventory_add_item(p_user_id uuid, p_inventory_type text, p_item_id text, p_item_type text, p_quantity integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_character_id UUID;
  v_inventory_id UUID;
  v_items JSONB;
  v_max_slots INTEGER;
  v_existing_index INTEGER := -1;
  v_empty_slot INTEGER := -1;
  v_max_stack INTEGER;
  v_current_qty INTEGER;
  i INTEGER;
BEGIN
  -- Resolve character_id from user_id
  SELECT id INTO v_character_id FROM characters WHERE user_id = p_user_id LIMIT 1;
  IF v_character_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'character_not_found');
  END IF;

  -- Get inventory
  SELECT id, items, max_slots INTO v_inventory_id, v_items, v_max_slots
  FROM inventories
  WHERE character_id = v_character_id AND inventory_type = p_inventory_type;

  IF v_inventory_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'inventory_not_found');
  END IF;

  -- Max stack by item type
  v_max_stack := CASE p_item_type
    WHEN 'equipment' THEN 1
    WHEN 'consumable' THEN 20
    WHEN 'material' THEN 99
    ELSE 10
  END;

  -- Find existing item or empty slot
  FOR i IN 0..v_max_slots-1 LOOP
    IF v_items->i IS NULL OR v_items->i = 'null'::jsonb THEN
      IF v_empty_slot = -1 THEN
        v_empty_slot := i;
      END IF;
    ELSIF (v_items->i->>'itemId') = p_item_id THEN
      v_current_qty := (v_items->i->>'quantity')::INTEGER;
      IF v_current_qty < v_max_stack THEN
        v_existing_index := i;
        EXIT;
      END IF;
    END IF;
  END LOOP;

  -- Add to existing stack
  IF v_existing_index >= 0 THEN
    v_current_qty := (v_items->v_existing_index->>'quantity')::INTEGER;
    v_items := jsonb_set(
      v_items,
      ARRAY[v_existing_index::TEXT, 'quantity'],
      to_jsonb(LEAST(v_current_qty + p_quantity, v_max_stack))
    );
  -- Add to empty slot
  ELSIF v_empty_slot >= 0 THEN
    WHILE jsonb_array_length(v_items) <= v_empty_slot LOOP
      v_items := v_items || 'null'::jsonb;
    END LOOP;

    v_items := jsonb_set(
      v_items,
      ARRAY[v_empty_slot::TEXT],
      jsonb_build_object(
        'slot', v_empty_slot,
        'itemId', p_item_id,
        'itemType', p_item_type,
        'quantity', LEAST(p_quantity, v_max_stack),
        'acquiredAt', now()
      )
    );
  ELSE
    RETURN jsonb_build_object('success', false, 'error', 'inventory_full');
  END IF;

  UPDATE inventories
  SET items = v_items, updated_at = now()
  WHERE id = v_inventory_id;

  RETURN jsonb_build_object(
    'success', true,
    'slot', COALESCE(NULLIF(v_existing_index, -1), v_empty_slot),
    'items', v_items
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.inventory_remove_item(p_user_id uuid, p_inventory_type text, p_slot integer, p_quantity integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_character_id UUID;
  v_inventory_id UUID;
  v_items JSONB;
  v_current_qty INTEGER;
  v_item JSONB;
BEGIN
  -- Resolve character_id from user_id
  SELECT id INTO v_character_id FROM characters WHERE user_id = p_user_id LIMIT 1;
  IF v_character_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'character_not_found');
  END IF;

  -- Get inventory
  SELECT id, items INTO v_inventory_id, v_items
  FROM inventories
  WHERE character_id = v_character_id AND inventory_type = p_inventory_type;

  IF v_inventory_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'inventory_not_found');
  END IF;

  -- Check slot exists
  v_item := v_items->p_slot;
  IF v_item IS NULL OR v_item = 'null'::jsonb THEN
    RETURN jsonb_build_object('success', false, 'error', 'slot_empty');
  END IF;

  v_current_qty := (v_item->>'quantity')::INTEGER;

  IF p_quantity >= v_current_qty THEN
    v_items := jsonb_set(v_items, ARRAY[p_slot::TEXT], 'null'::jsonb);
  ELSE
    v_items := jsonb_set(
      v_items,
      ARRAY[p_slot::TEXT, 'quantity'],
      to_jsonb(v_current_qty - p_quantity)
    );
  END IF;

  UPDATE inventories
  SET items = v_items, updated_at = now()
  WHERE id = v_inventory_id;

  RETURN jsonb_build_object(
    'success', true,
    'removedItem', v_item,
    'items', v_items
  );
END;
$function$;
