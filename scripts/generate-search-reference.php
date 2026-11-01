<?php
// Generate fixtures from the supplied original dependency, without connecting to its database.
$root = $argv[1] ?? getenv('LEGACY_DIR');
if (!$root) { fwrite(STDERR, "Pass the reference installation directory as the first argument or LEGACY_DIR.\n"); exit(1); }
require $root.'/vendor/autoload.php';
date_default_timezone_set('Asia/Shanghai');
$container = new Illuminate\Container\Container;
Illuminate\Container\Container::setInstance($container);
$container->instance('config', new Illuminate\Config\Repository([
    'database' => ['default'=>'fixture','connections'=>['fixture'=>['driver'=>'mysql','database'=>'fixture','prefix'=>'']]],
    'search-string' => ['fail'=>'exceptions','default'=>['keywords'=>['order_by'=>'sort','select'=>'fields','limit'=>'limit','offset'=>'from']]],
]));
Illuminate\Support\Facades\Facade::setFacadeApplication($container);
$capsule = new Illuminate\Database\Capsule\Manager($container);
$capsule->addConnection(['driver'=>'mysql','database'=>'fixture','prefix'=>'']);
$capsule->setAsGlobal();
$capsule->bootEloquent();
(new Lorisleiva\LaravelSearchString\ServiceProvider($container))->register();
Illuminate\Support\Carbon::setTestNow('2026-11-01 15:26:37');
class ReferenceUser extends Illuminate\Database\Eloquent\Model {
    use Lorisleiva\LaravelSearchString\Concerns\SearchString;
    public $timestamps=false;
    protected $table='users';
    protected $casts=['verified'=>'bool','is_dark_mode'=>'bool'];
    protected $searchStringColumns=['uid','email'=>['searchable'=>true],'nickname'=>['searchable'=>true],'avatar','score','permission','ip','last_sign_at'=>['date'=>true],'register_at'=>['date'=>true],'verified'=>['boolean'=>true],'is_dark_mode'=>['boolean'=>true]];
}
class ReferencePlayer extends Illuminate\Database\Eloquent\Model {
    use Lorisleiva\LaravelSearchString\Concerns\SearchString;
    public const CREATED_AT=null;
    public const UPDATED_AT='last_modified';
    protected $table='players';
    protected $searchStringColumns=['pid','uid','tid_skin'=>'/^(?:tid_)?skin$/','tid_cape'=>'/^(?:tid_)?cape$/','name'=>['searchable'=>true],'last_modified'=>['date'=>true]];
}
$cases = [
  ['users','score >= 200 and permission:0'], ['users','not (verified or permission > 0)'],
  ['users','nickname:"Alpha User" or nickname:Beta'], ['users','uid in (1,2,3)'],
  ['users','permission:-1,0'], ['users','not nickname:Alpha'], ['users','not "Alpha User"'],
  ['users','verified'], ['users','not verified'], ['users','verified:true'], ['users','verified:false'],
  ['users','email:NULL'], ['users','not email:NULL'], ['users','last_sign_at'],
  ['users','register_at:2020'], ['users','register_at > 2020'], ['users','register_at <= "Jan 2020"'],
  ['users','register_at:"2020-12-31 16:30"'], ['users','register_at:"Dec 31 2020 5pm"'],
  ['users','register_at:today'], ['users','register_at >= tomorrow'], ['users','register_at:"3 days ago"'],
  ['users','score>0 sort:-score,uid fields:uid,nickname'], ['users','not fields:email,ip sort:uid limit:1 from:10'],
  ['players','skin:1 not cape:0'], ['players','name:"Alpha Player" or uid:2'], ['players','sort:-skin,pid'],
];
$queries=[];
foreach($cases as [$entity,$expression]){
    $class=$entity==='users'?ReferenceUser::class:ReferencePlayer::class;
    $query=$class::usingSearchString($expression);
    $bindings=array_map(function($value){return $value instanceof DateTimeInterface?$value->format('Y-m-d H:i:s'):$value;},$query->getBindings());
    $queries[]=['entity'=>$entity,'expression'=>$expression,'sql'=>$query->toSql(),'bindings'=>$bindings];
}
$dates=[];
foreach(['2020','01/2020','2020-12-31','2020-12-31 16','2020-12-31 16:30','2020-12-31 16:30:10','Dec 31 2020 5pm','today','tomorrow','yesterday','3 days ago','next week','this week','last month','next year'] as $value){
    $date=new Lorisleiva\LaravelSearchString\Support\DateWithPrecision($value);
    $range=$date->getRange();if(!is_array($range))$range=[$range,$range];
    $dates[]=['value'=>$value,'range'=>array_map(fn($item)=>$item->format('Y-m-d H:i:s'),$range)];
}
file_put_contents('tests/fixtures/search-reference.json',json_encode(['reference'=>'Original laravel-search-string package; no SQL executed','now'=>'2026-11-01T07:26:37.000Z','timezone'=>'Asia/Shanghai','queries'=>$queries,'dates'=>$dates],JSON_PRETTY_PRINT|JSON_UNESCAPED_SLASHES).PHP_EOL);
echo count($queries).' queries and '.count($dates).' date ranges generated.'.PHP_EOL;
