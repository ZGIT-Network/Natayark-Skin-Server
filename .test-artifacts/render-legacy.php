<?php
require 'D:/Projects/mcnskinl/oldbf/vendor/autoload.php';
$skin=imagecreatefrompng($argv[1]);
$renderer=new Blessing\Minecraft();
$result=$renderer->renderSkin($skin, 12, ($argv[3] ?? '')==='alex');
imagepng($result,$argv[2]);
echo imagesx($result).'x'.imagesy($result).PHP_EOL;
