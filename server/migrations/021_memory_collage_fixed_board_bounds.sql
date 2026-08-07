UPDATE memory_collage_board_asset
   SET editable_left = 0.045000,
       editable_top = 0.130000,
       editable_right = 0.955000,
       editable_bottom = 0.945000
 WHERE asset_key IN (
   'board-01', 'board-02', 'board-03', 'board-04',
   'board-05', 'board-06', 'board-07'
 );
