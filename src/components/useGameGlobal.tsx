import { create } from "zustand";

export const useGameGlobal = create<any>(() =>{


    return {
        //
        playerGroup: null, //
        //
        // Where the player was placed at the start of the scene, published by
        // NavMeshRig's placePlayer once it resolves — null until then, because
        // placement is async and depends on the navmesh. Scene props that only
        // make sense at the start (the welcome sign) anchor to this rather than
        // to the player, who walks away from it.
        startPosition: null,
        //
    }
});

