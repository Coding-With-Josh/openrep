import { Intro } from "@/components/sections/intro";

export default function Home() {
  return (
    <div className="bg-white text-black dark:bg-neutral-950 dark:text-neutral-100 w-screen min-h-screen flex items-center justify-center">
            {/* <div 
        className="absolute inset-0 opacity-30 pointer-events-none" 
        style={{
          backgroundImage: `linear-gradient(to right, #f0f0f0 1px, transparent 1px), linear-gradient(to bottom, #f0f0f0 1px, transparent 1px)`,
          backgroundSize: '32px 32px'
        }} 
      /> */}
     <Intro/>
    </div>
  );
}
