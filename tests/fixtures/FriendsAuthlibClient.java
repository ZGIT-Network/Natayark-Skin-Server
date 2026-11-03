import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.Proxy;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Consumer;
import com.mojang.authlib.minecraft.UserApiService;

/** Calls the unmodified Mojang authlib shipped with 26.2 and 26.3, over real HTTP. */
public class FriendsAuthlibClient {
    static String origin;
    static Object discovery;
    static int checks;
    static void check(boolean value, String message) { if (!value) throw new AssertionError(message); checks++; }
    static Object invoke(Object target, String method, Class<?> argument, Object value) throws Exception {
        return target.getClass().getMethod(method, argument).invoke(target, value);
    }
    static Object service(String token) throws Exception {
        try {
            var env = Class.forName("com.mojang.authlib.Environment");
            var environment = env.getConstructor(String.class,String.class,String.class,String.class)
                .newInstance(origin,origin+"/api/yggdrasil/minecraftservices",origin,"FRIENDS_TEST");
            return Class.forName("com.mojang.authlib.yggdrasil.YggdrasilFriendsService")
                .getConstructor(String.class,Proxy.class,env).newInstance(token,Proxy.NO_PROXY,environment);
        } catch (NoSuchMethodException | ClassNotFoundException newer) {
            if (discovery == null) {
                var env = Class.forName("com.mojang.authlib.Environment");
                var environment = env.getConstructor(String.class,String.class).newInstance(origin+"/__discovery","FRIENDS_TEST");
                discovery = Class.forName("com.mojang.authlib.services.MinecraftServicesDiscoveryService")
                    .getMethod("create",Proxy.class,boolean.class,env).invoke(null,Proxy.NO_PROXY,false,environment);
            }
            return discovery.getClass().getMethod("createFriendsService",String.class).invoke(discovery,token);
        }
    }
    static UserApiService userService(String token) throws Exception {
        if (discovery != null) return (UserApiService) discovery.getClass().getMethod("createUserApiService",String.class).invoke(discovery,token);
        var env = Class.forName("com.mojang.authlib.Environment");
        var environment = env.getConstructor(String.class,String.class,String.class,String.class)
            .newInstance(origin,origin+"/api/yggdrasil/minecraftservices",origin,"FRIENDS_TEST");
        return (UserApiService) Class.forName("com.mojang.authlib.yggdrasil.YggdrasilUserApiService")
            .getConstructor(String.class,Proxy.class,env).newInstance(token,Proxy.NO_PROXY,environment);
    }
    static void success(Object result) { check(result.toString().equals("SUCCESS"),"Client operation failed: "+result); }
    static Object data(Object service) throws Exception {
        var value = new AtomicReference<Object>();
        success(invoke(service,"getFriendData",Consumer.class,(Consumer<Object>) value::set));
        return value.get();
    }
    static List<?> list(Object record, String field) throws Exception { return (List<?>) record.getClass().getMethod(field).invoke(record); }
    public static void main(String[] args) {
        try { run(); System.exit(0); }
        catch (Throwable error) { error.printStackTrace(System.err); System.exit(1); }
    }
    static void run() throws Exception {
        try {
            var input = new BufferedReader(new InputStreamReader(System.in));
            origin=input.readLine(); var tokenA=input.readLine(); var tokenB=input.readLine();
            var idA=UUID.fromString(input.readLine()); var idB=UUID.fromString(input.readLine()); var nameB=input.readLine();
            var alice=service(tokenA); var bob=service(tokenB);
            check(userService(tokenA).fetchProperties().flag(UserApiService.UserFlag.FRIENDS_ENABLED),"Game does not recognize the friends preference");
            success(invoke(alice,"sendFriendRequest",String.class,nameB));
            check(list(data(alice),"outgoingRequests").size()==1,"Outgoing request did not deserialize");
            check(list(data(bob),"incomingRequests").size()==1,"Incoming request did not deserialize");
            success(invoke(bob,"acceptIncomingFriendRequest",UUID.class,idA));
            check(list(data(service(tokenA)),"friends").size()==1,"Accepted friend did not deserialize");
            invoke(bob,"presence",String.class,"PLAYING_SERVER");
            var states=list(invoke(alice,"presence",String.class,"ONLINE"),"presence");
            check(states.size()==1,"Friend presence did not deserialize");
            var state=states.get(0);
            check(state.getClass().getMethod("status").invoke(state).toString().equals("PLAYING_SERVER"),"Presence status incorrect");
            check(state.getClass().getMethod("lastUpdated").invoke(state)!=null,"Presence timestamp did not deserialize");
            success(alice.getClass().getMethod("updateFriendSettings",boolean.class,boolean.class).invoke(alice,true,false));
            check(!userService(tokenA).fetchProperties().flag(UserApiService.UserFlag.ACCEPT_FRIEND_INVITES),"Privacy preference was not saved");
            success(alice.getClass().getMethod("updateFriendSettings",boolean.class,boolean.class).invoke(alice,true,true));
            check(!invoke(alice,"sendFriendRequest",UUID.class,idA).toString().equals("SUCCESS"),"Self invite was accepted");
            success(invoke(bob,"removeFriend",UUID.class,idA));
            check(list(data(service(tokenA)),"friends").isEmpty(),"Removed friend remains visible");
            success(invoke(alice,"sendFriendRequest",UUID.class,idB));
            success(invoke(alice,"revokeOutgoingFriendRequest",UUID.class,idB));
            check(list(data(service(tokenB)),"incomingRequests").isEmpty(),"Withdrawn request remains visible");
            System.out.println("AUTHLIB_FRIENDS_OK "+checks);
        } finally {
            if (discovery != null) ((java.util.concurrent.ExecutorService) discovery.getClass().getField("DISCOVERY_EXECUTOR").get(null)).shutdownNow();
        }
    }
}
