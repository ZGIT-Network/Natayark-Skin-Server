# Legacy rendering reference

`legacy-default-preview.png` was generated on 2026-10-29 by the original
`blessing/texture-renderer` package from the sibling `mcnskinl/oldbf/vendor`
checkout, using its Composer autoloader and PHP 8.0.2 with GD:

```php
$source = imagecreatefrompng('public/app/default-skin.png');
$image = (new Blessing\Minecraft())->renderSkin($source, 12, false);
imagepng($image, 'tests/fixtures/legacy-default-preview.png');
```

The 64×64 input is the default skin embedded in the original Blessing Skin
frontend. Both input and renderer are covered by the MIT notice in
`docs/legacy-license.txt`. The expected 430×437 image is generated independently
of the Node implementation. Tests compare its silhouette and colors on white,
allowing for the different polygon antialiasing used by GD and the JS rasterizer.
This does not assert pixel equality for every skin, model, or resolution.

`hd-layered-skin.png` is a 128×128 nearest-neighbor derivative of the default
skin with an opaque green shirt overlay. It tests scaled overlay UVs. The old
PHP renderer copied fixed 64-pixel coordinates at HD resolutions; the Node
renderer corrects this bug rather than using that broken output as a reference.
